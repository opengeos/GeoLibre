import { datumShiftFor, withDatumShift } from "@geolibre/core";
import type { RasterControl } from "maplibre-gl-raster";

/** The raster control's EPSG resolver type. */
export type EpsgResolver = NonNullable<
  NonNullable<ConstructorParameters<typeof RasterControl>[0]>["epsgResolver"]
>;

/**
 * An EPSG resolver for the raster control (deck.gl COG layers) that adds the
 * datum shift for coordinate systems whose shift epsg.io's PROJJSON leaves
 * out (see `datum-shift.ts` in @geolibre/core), and leaves every other code to
 * `fallback`. Those codes resolve offline, from the same EPSG tables the rest
 * of GeoLibre uses, so a raster on the British National Grid, say, lands where
 * vector layers and the basemap put it.
 *
 * @param fallback The resolver for every other code (the control's default).
 */
export function datumShiftEpsgResolver(fallback: EpsgResolver): EpsgResolver {
  const resolved = new Map<number, ReturnType<EpsgResolver>>();
  return (epsg) => {
    if (!datumShiftFor(epsg)) return fallback(epsg);
    let projection = resolved.get(epsg);
    if (!projection) {
      projection = (async () => {
        const [{ toProj4 }, { default: proj4 }] = await Promise.all([
          import("geotiff-geokeys-to-proj4"),
          import("proj4"),
        ]);
        const raw = toProj4({ ProjectedCSTypeGeoKey: epsg } as never).proj4 ?? "";
        if (!raw) return fallback(epsg);
        let definition = withDatumShift(raw.replace(/\+axis=\w+\s*/g, "").trim(), epsg);
        // The COG layer reads the units off the definition: metres unless
        // the tables give another unit.
        if (!/\+proj=longlat\b/.test(definition) && !/\+(units|to_meter)=/.test(definition)) {
          definition += " +units=m";
        }
        const name = `GEOLIBRE:${epsg}`;
        proj4.defs(name, definition);
        return proj4.defs(name) as unknown as Awaited<ReturnType<EpsgResolver>>;
      })().catch(() => {
        // Not cached: a transient failure of the fallback (an epsg.io fetch)
        // must not stick to this code.
        resolved.delete(epsg);
        return fallback(epsg);
      });
      resolved.set(epsg, projection);
    }
    return projection;
  };
}
