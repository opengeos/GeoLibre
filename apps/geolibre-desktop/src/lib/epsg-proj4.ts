// Offline EPSG code → proj4 definition lookup, shared by the desktop WMS tile
// reprojection (wms-projected.ts) and GML reprojection (gml-projection.ts).
// The EPSG tables come from geotiff-geokeys-to-proj4; both it and proj4 are
// loaded on first use, so a session that never needs them never pays for them.

import { withDatumShift } from "@geolibre/core";
import type proj4Type from "proj4";

/** A resolved EPSG CRS. */
export interface EpsgProjection {
  /** The proj4 definition with any `+axis` term removed (x = east, y = north). */
  definition: string;
  /** Whether the EPSG axis order is north-first (`+axis=ne` in the tables). */
  northFirst: boolean;
  /** Whether the CRS is geographic (`+proj=longlat`), in degrees. */
  geographic: boolean;
  /** The proj4 library, already loaded, for building converters. */
  proj4: typeof proj4Type;
}

const cache = new Map<number, Promise<EpsgProjection | null>>();

/**
 * Resolve an EPSG code from the bundled tables, or null when the tables do not
 * know it or proj4 cannot build a converter for its definition. Results
 * (including failures) are cached per code: both packages are bundled, so an
 * import error is not transient.
 *
 * @param code - The numeric EPSG code, e.g. 2180.
 * @returns The projection, or null for an unknown code.
 */
export function resolveEpsgProjection(code: number): Promise<EpsgProjection | null> {
  let projection = cache.get(code);
  if (!projection) {
    projection = (async () => {
      const [{ toProj4 }, { default: proj4 }] = await Promise.all([
        import("geotiff-geokeys-to-proj4"),
        import("proj4"),
      ]);
      // geotiff-geokeys-to-proj4 resolves geographic codes through
      // ProjectedCSTypeGeoKey too (EPSG:4269 gives +proj=longlat).
      // tests/wms-projected.test.ts covers both kinds, so a dependency bump
      // that changes this fails there.
      const resolved = toProj4({ ProjectedCSTypeGeoKey: code });
      const raw = resolved.proj4 ?? "";
      if (!raw || resolved.errors?.CRSNotSupported) return null;
      // The tables leave some datums' shifts out (the British National Grid,
      // DHDN, Amersfoort...): add them, or data lands up to a few hundred
      // metres off.
      const definition = withDatumShift(raw.replace(/\+axis=\w+\s*/g, "").trim(), code);
      // The tables also name projections proj4js does not implement
      // (EPSG:6244 is +proj=col_urban), so build a converter once here. A WMS
      // can advertise dozens of them, so this is unsupported, not a warning.
      try {
        proj4("EPSG:4326", definition);
      } catch {
        return null;
      }
      return {
        definition,
        northFirst: /\+axis=ne/.test(raw),
        geographic: /\+proj=longlat\b/.test(raw),
        proj4,
      };
    })().catch((error) => {
      console.warn(`Could not resolve EPSG:${code} to a projection`, error);
      return null;
    });
    cache.set(code, projection);
  }
  return projection;
}
