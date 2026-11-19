/**
 * Coordinate conversions for a GeoPDF viewport's CRS (GH #3523).
 *
 * A viewport's `/GPTS` are latitude/longitude on the datum of the CRS named in
 * `/GCS`, not necessarily WGS 84 (a Greek Grid map is on GGRS87, a British
 * National Grid one on OSGB36). They are converted into the CRS's projected
 * coordinates to fit the viewport transform, and the fitted frame corners are
 * converted from there to WGS 84 for the map.
 */
import type proj4Type from "proj4";
import type { GeoPdfCrs } from "./georef";

/** Conversions for one viewport CRS. */
export interface GeoPdfCrsConverters {
  /** A label for the CRS, e.g. "EPSG:2100". */
  label: string;
  /** GPTS latitude/longitude (on the CRS's datum) to CRS coordinates. */
  latLonToCrs: (lat: number, lon: number) => [number, number];
  /** CRS coordinates to WGS 84 `[lng, lat]`. */
  crsToWgs84: (x: number, y: number) => [number, number];
}

/** The part of a parsed proj4 projection that carries its datum. */
interface ParsedProj {
  a?: number;
  b?: number;
  datum?: unknown;
}

type ProjFactory = (definition: string) => ParsedProj;

/**
 * A longitude/latitude projection on a CRS's own datum: proj4 applies no
 * datum shift between two projections that share one datum object, so
 * converting from it reads GPTS on the CRS's datum rather than on WGS 84. The
 * datum is shared rather than rebuilt from parameters, so it works for a PROJ
 * string and a WKT alike.
 *
 * Args:
 *   parsed: The CRS as parsed by `proj4.Proj`.
 *   makeProj: `proj4.Proj`.
 *
 * Returns:
 *   The projection, or null when the ellipsoid is unknown.
 */
export function datumGeographicProj(parsed: ParsedProj, makeProj: ProjFactory): ParsedProj | null {
  const { a, b } = parsed;
  if (!(typeof a === "number" && a > 0) || !(typeof b === "number" && b > 0)) return null;
  const geographic = makeProj(`+proj=longlat +a=${a} +b=${b} +no_defs`);
  if (parsed.datum) geographic.datum = parsed.datum;
  return geographic;
}

/**
 * Build the converters for a viewport CRS: its EPSG code through the bundled
 * EPSG tables, else its WKT through proj4.
 *
 * Args:
 *   crs: The viewport's `/GCS`.
 *   resolveEpsg: Resolves an EPSG code to a PROJ definition, or null.
 *   proj4: The proj4 library.
 *
 * Returns:
 *   The converters, or null when the CRS cannot be resolved.
 */
export async function geoPdfCrsConverters(
  crs: GeoPdfCrs,
  resolveEpsg: (code: number) => Promise<string | null>,
  proj4: typeof proj4Type,
): Promise<GeoPdfCrsConverters | null> {
  const candidates: { label: string; definition: string }[] = [];
  if (crs.epsg !== null) {
    const definition = await resolveEpsg(crs.epsg);
    if (definition) candidates.push({ label: `EPSG:${crs.epsg}`, definition });
  }
  if (crs.wkt)
    candidates.push({ label: crs.epsg !== null ? `EPSG:${crs.epsg}` : "WKT", definition: crs.wkt });
  for (const { label, definition } of candidates) {
    try {
      const toWgs84 = proj4(definition);
      const makeProj = (proj4 as unknown as { Proj: ProjFactory }).Proj;
      const parsed = makeProj(definition);
      const geographic = datumGeographicProj(parsed, makeProj);
      // proj4 accepts parsed projection objects as well as definitions.
      const fromDatum = geographic
        ? proj4(geographic as unknown as string, parsed as unknown as string)
        : toWgs84;
      return {
        label,
        latLonToCrs: (lat, lon) => fromDatum.forward([lon, lat]) as [number, number],
        crsToWgs84: (x, y) => toWgs84.inverse([x, y]) as [number, number],
      };
    } catch {
      // Try the next description of the CRS.
    }
  }
  return null;
}
