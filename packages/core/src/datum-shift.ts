/**
 * Datum shifts (proj4 `+towgs84` Helmert parameters) for coordinate systems
 * whose datum is not WGS84-compatible, by EPSG code.
 *
 * The offline EPSG tables GeoLibre resolves codes with
 * (`geotiff-geokeys-to-proj4`) leave the shift out for many national grids, and
 * epsg.io's PROJJSON for a projected CRS carries no transformation either, so
 * proj4 would treat those datums as WGS84 and place data tens to hundreds of
 * metres off (about 100 m for the British National Grid). The parameters are
 * EPSG's (the transformation epsg.io's proj4 strings use), within a few
 * metres of PROJ's best transformation for each (15 m for the NAD27 mean);
 * grid-based transformations (OSTN15, NTv2, NADCON) are finer but need grid
 * files proj4 does not ship. Datums the tables already shift (ED50, AGD66,
 * AGD84, Tokyo, NZGD49, TM75 and others) are not listed.
 */

interface DatumShift {
  /** Datum name, for the record. */
  datum: string;
  /** EPSG datum codes (`GeogGeodeticDatumGeoKey`). */
  datums: number[];
  /** EPSG geographic and projected CRS codes on the datum. */
  crs: number[];
  towgs84: string;
}

/** Inclusive ranges of codes, as a list. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const SHIFTS: DatumShift[] = [
  {
    datum: "OSGB 1936",
    datums: [6277],
    crs: [4277, 27700],
    towgs84: "446.448,-125.157,542.06,0.15,0.247,0.842,-20.489",
  },
  {
    datum: "TM65 (Ireland)",
    datums: [6299],
    crs: [4299, 29902],
    towgs84: "482.5,-130.6,564.6,-1.042,-0.214,-0.631,8.15",
  },
  {
    datum: "DHDN",
    datums: [6314],
    crs: [4314, 3068, ...range(31466, 31469)],
    towgs84: "598.1,73.7,418.2,0.202,0.045,-2.455,6.7",
  },
  {
    datum: "Amersfoort",
    datums: [6289],
    crs: [4289, 28992],
    towgs84: "565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725",
  },
  {
    datum: "CH1903",
    datums: [6149],
    crs: [4149, 21781],
    towgs84: "674.4,15.1,405.3,0,0,0,0",
  },
  {
    datum: "CH1903+",
    datums: [6150],
    crs: [4150, 2056],
    towgs84: "674.374,15.056,405.346,0,0,0,0",
  },
  {
    datum: "Belge 1972",
    datums: [6313],
    crs: [4313, 31370],
    towgs84: "-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747",
  },
  {
    datum: "S-JTSK",
    datums: [6156],
    crs: [4156, 5514],
    towgs84: "589,76,480,0,0,0,0",
  },
  {
    datum: "Monte Mario",
    datums: [6265],
    crs: [4265, 3003, 3004],
    towgs84: "-104.1,-49.1,-9.9,0.971,-2.917,0.714,-11.68",
  },
  {
    datum: "HD72",
    datums: [6237],
    crs: [4237, 23700],
    towgs84: "52.17,-71.82,-14.9,0,0,0,0",
  },
  {
    datum: "GGRS87",
    datums: [6121],
    crs: [4121, 2100],
    towgs84: "-199.87,74.79,246.62,0,0,0,0",
  },
  {
    datum: "Hong Kong 1980",
    datums: [6611],
    crs: [4611, 2326],
    towgs84: "-162.619,-276.959,-161.764,0.067753,-2.24365,-1.15883,-1.09425",
  },
  {
    // A conterminous-US mean, so only the UTM zones over it (10 N to 19 N),
    // not the geographic CRS or the datum, which span all of North America.
    datum: "NAD27 (conterminous US mean)",
    datums: [],
    crs: range(26710, 26719),
    towgs84: "-8,160,176,0,0,0,0",
  },
];

const BY_CRS = new Map<number, string>();
const BY_DATUM = new Map<number, string>();
for (const shift of SHIFTS) {
  for (const code of shift.crs) BY_CRS.set(code, shift.towgs84);
  for (const code of shift.datums) BY_DATUM.set(code, shift.towgs84);
}

/**
 * The `+towgs84` parameters for an EPSG CRS or datum code, or null when the
 * code is not one whose shift GeoLibre adds.
 *
 * @param crs An EPSG geographic or projected CRS code.
 * @param datum An EPSG datum code, used when the CRS code is unknown.
 */
export function datumShiftFor(
  crs: number | null | undefined,
  datum?: number | null,
): string | null {
  return (
    (crs != null ? BY_CRS.get(crs) : undefined) ??
    (datum != null ? BY_DATUM.get(datum) : undefined) ??
    null
  );
}

/** GeoTIFF's "user-defined" geokey value. */
const USER_DEFINED = 32767;

/** A geokey's numeric value, or null for a missing or user-defined one. */
function keyCode(value: unknown): number | null {
  const code = Number(value);
  return Number.isInteger(code) && code > 0 && code !== USER_DEFINED ? code : null;
}

/**
 * Add the datum shift to a proj4 definition built for an EPSG CRS (or from a
 * GeoTIFF's geokeys), when the definition has none and the CRS is one whose
 * shift is known. A definition that already names a datum transformation
 * (`+towgs84`, `+datum=`, `+nadgrids=`) is returned unchanged.
 *
 * @param definition A proj4 definition string.
 * @param crs The EPSG CRS code it was built for.
 * @param datum The EPSG datum code, for a user-defined CRS.
 */
export function withDatumShift(
  definition: string,
  crs: number | null | undefined,
  datum?: number | null,
): string {
  if (/\+(towgs84|datum|nadgrids)=/.test(definition)) return definition;
  const shift = datumShiftFor(crs, datum);
  return shift ? `${definition.trim()} +towgs84=${shift}` : definition;
}

/**
 * Add the datum shift to a proj4 definition built from GeoTIFF geokeys, from
 * the projected or geographic CRS code, else the datum code.
 *
 * @param definition The proj4 definition built from `geoKeys`.
 * @param geoKeys The GeoTIFF's geokeys (geotiff.js names).
 */
export function withGeoKeysDatumShift(
  definition: string,
  geoKeys: Record<string, unknown> | null | undefined,
): string {
  if (!geoKeys) return definition;
  const crs =
    keyCode(geoKeys.ProjectedCSTypeGeoKey) ??
    keyCode(geoKeys.ProjectedCRSGeoKey) ??
    keyCode(geoKeys.GeographicTypeGeoKey) ??
    keyCode(geoKeys.GeodeticCRSGeoKey);
  const datum = keyCode(geoKeys.GeogGeodeticDatumGeoKey) ?? keyCode(geoKeys.GeodeticDatumGeoKey);
  return withDatumShift(definition, crs, datum);
}

/** The part of `cog-tiler-wasm` the datum-shift hook needs (0.5 and later). */
interface CogTilerCrsHook {
  setSourceCrsResolver?: (
    fn: ((def: string, geoKeys: Record<string, unknown>) => string | null | undefined) | null,
  ) => void;
}

/**
 * Have `cog-tiler-wasm` add the datum shift to each COG's source CRS, so a
 * raster it tiles lands where the rest of GeoLibre puts it. Idempotent; a
 * tiler without the hook is left as it is. WKT definitions are left alone.
 *
 * @param module The imported `cog-tiler-wasm` module.
 */
export function installCogTilerDatumShift(module: CogTilerCrsHook): void {
  module.setSourceCrsResolver?.((def, geoKeys) =>
    def.trimStart().startsWith("+") ? withGeoKeysDatumShift(def, geoKeys) : def,
  );
}
