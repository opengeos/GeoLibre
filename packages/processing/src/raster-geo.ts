import { normalizeProj4Definition, withGeoKeysDatumShift } from "@geolibre/core";
import type { FeatureCollection, Geometry, Position } from "geojson";
import type { RasterData } from "./raster-client";

/**
 * Georeferencing helpers shared by the in-browser raster tools that need a
 * CRS (reproject, clip by mask, zonal statistics, interpolation) or emit
 * vectors (polygonize, contour). They mirror the conventions of the rasterio
 * sidecar workers so both engines agree on the same inputs:
 *
 * - A GeoJSON input's CRS is its legacy `crs` member's trailing EPSG digits,
 *   else WGS84 (EPSG:4326), as the workers resolve it.
 * - Vector outputs carry a `crs` member naming the raster's EPSG code when it is
 *   not 4326, exactly as the workers write it.
 */

/** A proj4 forward function on `[x, y]` pairs. */
export type CoordTransform = (coord: [number, number]) => [number, number];

/** The north-up affine of a raster: world = origin + (col, row) * (resX, -resY). */
export interface NorthUpGrid {
  width: number;
  height: number;
  originX: number;
  originY: number;
  resX: number;
  resY: number;
}

/**
 * Return the raster flipped into north-up, west-to-east orientation (the
 * layout every new client tool and the GeoTIFF writer assume). A raster that is
 * already north-up is returned as is; a rotated/sheared one is rejected.
 *
 * @param raster The decoded raster.
 * @returns The same raster, or a re-ordered copy.
 */
export function toNorthUp(raster: RasterData): RasterData {
  if (raster.rotated) {
    throw new Error(
      "This raster has a rotated or sheared transform, which the in-browser engine cannot process. Use the sidecar (rasterio/GDAL) engine instead.",
    );
  }
  if (!raster.flipX && !raster.flipY) return raster;
  const { width, height } = raster;
  const bands = raster.bands.map((band) => {
    const out = new Float32Array(band.length);
    for (let r = 0; r < height; r += 1) {
      const srcRow = raster.flipY ? height - 1 - r : r;
      for (let c = 0; c < width; c += 1) {
        const srcCol = raster.flipX ? width - 1 - c : c;
        out[r * width + c] = band[srcRow * width + srcCol];
      }
    }
    return out;
  });
  return {
    ...raster,
    bands,
    originX: raster.flipX ? raster.originX - width * raster.resX : raster.originX,
    originY: raster.flipY ? raster.originY + height * raster.resY : raster.originY,
    flipX: false,
    flipY: false,
  };
}

/** The EPSG code a raster's GeoKeys name, or null for a user-defined/absent CRS. */
export function rasterEpsg(raster: Pick<RasterData, "geoKeys">): number | null {
  const keys = raster.geoKeys ?? {};
  for (const key of ["ProjectedCSTypeGeoKey", "GeographicTypeGeoKey"]) {
    const code = Number(keys[key]);
    if (Number.isInteger(code) && code > 0 && code !== 32767) return code;
  }
  return null;
}

/** Whether the raster's GeoKeys describe a geographic (lon/lat) CRS. */
export function rasterIsGeographic(raster: Pick<RasterData, "geoKeys">): boolean {
  const keys = raster.geoKeys ?? {};
  const modelType = keys.GTModelTypeGeoKey as number | undefined;
  if (modelType === 2) return true;
  if (modelType === 1) return false;
  return keys.ProjectedCSTypeGeoKey == null && keys.GeographicTypeGeoKey != null;
}

/**
 * Resolve the proj4 definition of a raster's CRS from its GeoKeys (with the
 * datum shift GeoLibre adds where the EPSG tables leave it out), or throw a
 * clear error when the raster carries no usable CRS.
 *
 * @param raster The decoded raster.
 * @param toolName Tool name for the error message.
 */
export async function rasterCrsDefinition(raster: RasterData, toolName: string): Promise<string> {
  const keys = raster.geoKeys ?? {};
  const epsg = rasterEpsg(raster);
  if (epsg === 4326) return "EPSG:4326";
  if (epsg === 3857) return "EPSG:3857";
  if (!Object.keys(keys).length) {
    throw new Error(`Input raster has no CRS; ${toolName} requires a georeferenced raster.`);
  }
  const { toProj4 } = await import("geotiff-geokeys-to-proj4");
  const resolved = toProj4(keys as never);
  if (!resolved.proj4 || resolved.errors?.CRSNotSupported) {
    throw new Error(
      `The raster's CRS could not be resolved in the browser; ${toolName} needs the sidecar (rasterio/GDAL) engine for it.`,
    );
  }
  return withGeoKeysDatumShift(normalizeProj4Definition(resolved.proj4), keys);
}

/**
 * Build a coordinate transform between two proj4 definitions (identity when
 * they are the same string).
 */
export async function crsTransform(from: string, to: string): Promise<CoordTransform> {
  if (from === to) return (c) => [c[0], c[1]];
  const { default: proj4 } = await import("proj4");
  const converter = proj4(from, to);
  return (c) => converter.forward([c[0], c[1]]) as [number, number];
}

/** Resolve an EPSG code to a proj4 definition, or throw when it is unknown. */
export async function epsgDefinition(code: number): Promise<string> {
  if (code === 4326) return "EPSG:4326";
  if (code === 3857) return "EPSG:3857";
  const { resolveCrsDefinition } = await import("./crs-proj4");
  const resolved = await resolveCrsDefinition(`EPSG:${code}`);
  if (!resolved) {
    throw new Error(`Unsupported or unknown CRS "EPSG:${code}".`);
  }
  return resolved.definition;
}

/**
 * The EPSG code a GeoJSON object's legacy `crs` member names (its trailing
 * digits, the way the sidecar workers parse it), else 4326.
 */
export function geojsonEpsg(geojson: unknown): number {
  const member = (geojson as { crs?: { properties?: { name?: unknown } } } | null)?.crs;
  const name = String(member?.properties?.name ?? "");
  const digits = /(\d+)$/.exec(name);
  if (digits) {
    const code = Number(digits[1]);
    // OGC's CRS84 is WGS84 lon/lat; "84" is not an EPSG code.
    if (/CRS84$/i.test(name)) return 4326;
    if (Number.isInteger(code) && code > 0) return code;
  }
  return 4326;
}

/** The legacy GeoJSON `crs` member for an EPSG code (none for 4326). */
export function crsMember(epsg: number | null): Record<string, unknown> | undefined {
  if (epsg == null || epsg === 4326) return undefined;
  return {
    type: "name",
    properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` },
  };
}

/** GeoTIFF GeoKeys for an EPSG code, geographic or projected. */
export function geoKeysForEpsg(code: number, geographic: boolean): Record<string, unknown> {
  return geographic
    ? {
        GTModelTypeGeoKey: 2,
        GTRasterTypeGeoKey: 1,
        GeographicTypeGeoKey: code,
        GeogAngularUnitsGeoKey: 9102,
      }
    : {
        GTModelTypeGeoKey: 1,
        GTRasterTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: code,
      };
}

/**
 * Normalize a GeoJSON input to a list of features the way the sidecar workers
 * do: a FeatureCollection's features, a single Feature, or a bare geometry.
 */
export function geojsonFeatures(geojson: unknown): FeatureCollection["features"] {
  const obj = geojson as {
    type?: string;
    features?: unknown;
    geometry?: unknown;
  } | null;
  if (!obj || typeof obj !== "object") throw new Error("The vector input is not valid GeoJSON.");
  if (obj.type === "FeatureCollection") {
    return (Array.isArray(obj.features) ? obj.features : []) as FeatureCollection["features"];
  }
  if (obj.type === "Feature") return [obj as FeatureCollection["features"][number]];
  return [{ type: "Feature", properties: {}, geometry: obj as unknown as Geometry }];
}

/** Map every position of a geometry through `fn` (Z/M values are dropped). */
export function mapGeometry(geometry: Geometry, fn: CoordTransform): Geometry {
  const p = (pos: Position): Position => fn([pos[0], pos[1]]);
  switch (geometry.type) {
    case "Point":
      return { type: "Point", coordinates: p(geometry.coordinates) };
    case "MultiPoint":
      return { type: "MultiPoint", coordinates: geometry.coordinates.map(p) };
    case "LineString":
      return { type: "LineString", coordinates: geometry.coordinates.map(p) };
    case "MultiLineString":
      return {
        type: "MultiLineString",
        coordinates: geometry.coordinates.map((l) => l.map(p)),
      };
    case "Polygon":
      return {
        type: "Polygon",
        coordinates: geometry.coordinates.map((r) => r.map(p)),
      };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates.map((poly) => poly.map((r) => r.map(p))),
      };
    case "GeometryCollection":
      return {
        type: "GeometryCollection",
        geometries: geometry.geometries.map((g) => mapGeometry(g, fn)),
      };
  }
}
