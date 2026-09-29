// Reprojecting GML parse: parseGmlFeatureCollection handles WGS84-like and Web
// Mercator on its own; any other EPSG CRS a document names (a national grid
// such as EPSG:2180, a UTM zone) is resolved here from the bundled EPSG tables
// and handed back, so a WFS that ignores the requested srsName (MapServer's
// WFS 1.0.0 does) still lands in the right place.

import type { FeatureCollection, Geometry, Position } from "geojson";
import { resolveEpsgProjection } from "./epsg-proj4";
import {
  GmlUnsupportedCrsError,
  parseEpsgSrsName,
  parseGmlFeatureCollection,
  type GmlCrs,
  type GmlParseOptions,
} from "./gml";

// Distinct CRSs one document may need resolved; each costs a re-parse.
const MAX_RESOLVED_CRS = 8;

/**
 * Parse a GML feature collection, reprojecting any EPSG CRS to lon/lat.
 *
 * @param text - The GML document.
 * @param options - The CRS to assume when the document states none.
 * @returns The features, in WGS84 lon/lat.
 * @throws {GmlUnsupportedCrsError} For a CRS that is not an EPSG code the
 *   bundled tables know.
 */
export async function parseGmlWithReprojection(
  text: string,
  options: Pick<GmlParseOptions, "defaultSrsName"> = {},
): Promise<FeatureCollection<Geometry | null>> {
  const extraCrs = new Map<string, GmlCrs>();
  for (;;) {
    try {
      return parseGmlFeatureCollection(text, { ...options, extraCrs });
    } catch (error) {
      if (!(error instanceof GmlUnsupportedCrsError) || extraCrs.size >= MAX_RESOLVED_CRS) {
        throw error;
      }
      const crs = await resolveEpsgCrs(error.srsName);
      if (!crs) throw error;
      extraCrs.set(error.srsName, crs);
    }
  }
}

/**
 * Build the {@link GmlCrs} for an EPSG `srsName` from the bundled tables.
 *
 * @param srsName - The CRS name, in URN, URL or `EPSG:n` form.
 * @returns How to read positions in it, or null when it cannot be resolved.
 */
export async function resolveEpsgCrs(srsName: string): Promise<GmlCrs | null> {
  const name = parseEpsgSrsName(srsName);
  if (!name) return null;
  const projection = await resolveEpsgProjection(name.code);
  if (!projection) return null;
  // Geographic CRSs are latitude-first in the EPSG registry even when the
  // tables omit +axis; projected ones say so (EPSG:2180 is north, east).
  const northFirst = projection.geographic || projection.northFirst;
  // proj4 also shifts a geographic datum other than WGS84 (Tokyo is ~400 m off).
  const converter = projection.proj4(projection.definition, "EPSG:4326");
  return {
    swapAxes: name.authorityAxisOrder && northFirst,
    toLonLat: ([x, y, ...rest]: Position) => [...(converter.forward([x, y]) as number[]), ...rest],
  };
}
