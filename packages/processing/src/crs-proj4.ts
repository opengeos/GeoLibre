/**
 * Client-side CRS resolution and GeoJSON coordinate reprojection backed by
 * `proj4` and the bundled `geotiff-geokeys-to-proj4` EPSG tables.
 */

import { normalizeProj4Definition } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type proj4Type from "proj4";

export interface ResolvedCrs {
  /** Normalized proj4 definition string (with any `+axis` stripped so coordinates are east-first). */
  definition: string;
  /** The loaded proj4 instance. */
  proj4: typeof proj4Type;
}

const EPSG_RE = /^EPSG\s*:\s*(\d+)$/i;
const CRS84_RE = /^(?:OGC:)?CRS84$/i;
const MAX_CRS_CACHE_ENTRIES = 128;
const definitionCache = new Map<string, Promise<ResolvedCrs | null>>();

/**
 * Resolve a CRS string (such as `"EPSG:3857"`, `"EPSG:32617"`, `"CRS84"`, or a
 * raw PROJ string) into a proj4 definition validated against WGS84.
 */
export function resolveCrsDefinition(crsInput: string): Promise<ResolvedCrs | null> {
  const trimmed = crsInput.trim();
  if (!trimmed) return Promise.resolve(null);
  const cacheKey = trimmed.toUpperCase().startsWith("EPSG")
    ? trimmed.replace(/\s+/g, "").toUpperCase()
    : trimmed;

  const existing = definitionCache.get(cacheKey);
  if (existing) {
    // Refresh recency for LRU eviction.
    definitionCache.delete(cacheKey);
    definitionCache.set(cacheKey, existing);
    return existing;
  }

  const pending = (async (): Promise<ResolvedCrs | null> => {
    const { default: proj4 } = await import("proj4");

    if (CRS84_RE.test(trimmed) || cacheKey === "EPSG:4326") {
      return { definition: "EPSG:4326", proj4 };
    }
    if (cacheKey === "EPSG:3857" || cacheKey === "EPSG:900913" || cacheKey === "EPSG:102100") {
      return { definition: "EPSG:3857", proj4 };
    }

    const epsgMatch = EPSG_RE.exec(trimmed);
    let definition: string;
    if (epsgMatch) {
      const code = Number(epsgMatch[1]);
      if (!Number.isInteger(code) || code <= 0 || code >= 32767) return null;
      const { toProj4 } = await import("geotiff-geokeys-to-proj4");
      const resolved = toProj4({ ProjectedCSTypeGeoKey: code });
      const raw = resolved.proj4 ?? "";
      if (!raw || resolved.errors?.CRSNotSupported) return null;
      definition = normalizeProj4Definition(raw, code);
    } else {
      definition = normalizeProj4Definition(trimmed);
    }

    try {
      proj4(definition, "EPSG:4326");
    } catch {
      return null;
    }
    return { definition, proj4 };
  })().catch((error) => {
    console.warn(`Could not resolve CRS "${trimmed}" to a projection`, error);
    return null;
  });

  if (definitionCache.size >= MAX_CRS_CACHE_ENTRIES) {
    const oldest = definitionCache.keys().next().value;
    if (oldest !== undefined) definitionCache.delete(oldest);
  }
  definitionCache.set(cacheKey, pending);
  return pending;
}

function transformPosition(
  pos: Position,
  forward: (coord: [number, number]) => [number, number],
): Position {
  const x = pos[0];
  const y = pos[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Cannot reproject non-finite coordinate [${x}, ${y}].`);
  }
  const [lon, lat] = forward([x, y]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error(`Reprojection produced non-finite coordinate from [${x}, ${y}].`);
  }
  return pos.length > 2 ? [lon, lat, ...pos.slice(2)] : [lon, lat];
}

function transformGeometry(
  geometry: Geometry,
  forward: (coord: [number, number]) => [number, number],
): Geometry {
  switch (geometry.type) {
    case "Point":
      return {
        type: "Point",
        coordinates: transformPosition(geometry.coordinates, forward),
      };
    case "MultiPoint":
      return {
        type: "MultiPoint",
        coordinates: geometry.coordinates.map((p) => transformPosition(p, forward)),
      };
    case "LineString":
      return {
        type: "LineString",
        coordinates: geometry.coordinates.map((p) => transformPosition(p, forward)),
      };
    case "MultiLineString":
      return {
        type: "MultiLineString",
        coordinates: geometry.coordinates.map((line) =>
          line.map((p) => transformPosition(p, forward)),
        ),
      };
    case "Polygon":
      return {
        type: "Polygon",
        coordinates: geometry.coordinates.map((ring) =>
          ring.map((p) => transformPosition(p, forward)),
        ),
      };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates.map((poly) =>
          poly.map((ring) => ring.map((p) => transformPosition(p, forward))),
        ),
      };
    case "GeometryCollection":
      return {
        type: "GeometryCollection",
        geometries: geometry.geometries.map((g) => transformGeometry(g, forward)),
      };
  }
}

/**
 * Reinterpret a FeatureCollection's coordinates in `sourceCrs` and transform
 * them to WGS84 (`EPSG:4326`), preserving feature properties and Z/M values.
 */
export async function reprojectFeatureCollectionToWgs84(
  fc: FeatureCollection,
  sourceCrs: string,
): Promise<FeatureCollection> {
  const resolved = await resolveCrsDefinition(sourceCrs);
  if (!resolved) {
    throw new Error(
      `Unsupported or unknown CRS "${sourceCrs}". Use an EPSG code (e.g. EPSG:3857, EPSG:32617) or PROJ string.`,
    );
  }
  const converter =
    resolved.definition === "EPSG:4326"
      ? (coord: [number, number]): [number, number] => [coord[0], coord[1]]
      : resolved.proj4(resolved.definition, "EPSG:4326").forward;

  // GeoJSON always stores coordinates in traditional GIS axis order [x, y]
  // (matching pyproj's `always_xy=True` in the Python sidecar), so `definition`
  // has `+axis` normalized to east-first.
  const features: Feature[] = fc.features.map((feature) => {
    const { bbox: _dropBbox, ...rest } = feature;
    return {
      ...rest,
      geometry: feature.geometry
        ? transformGeometry(feature.geometry, converter)
        : feature.geometry,
    };
  });
  return { type: "FeatureCollection", features };
}
