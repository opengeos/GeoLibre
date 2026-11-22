import type { FeatureCollection, Geometry } from "geojson";
import {
  antimeridianAwareBbox,
  type GeoLibreLayer,
  isGeoArrowBatch,
  computeGeoArrowBBox,
  type GeoArrowBatch,
} from "@geolibre/core";

export type GeometryKind = "point" | "line" | "polygon";

export interface GeometryProfile {
  hasPoint: boolean;
  hasLine: boolean;
  hasPolygon: boolean;
}

const geometryProfileCache = new WeakMap<FeatureCollection | GeoArrowBatch, GeometryProfile>();

export function detectGeometryProfile(
  data: FeatureCollection | GeoArrowBatch | undefined,
): GeometryProfile {
  const profile: GeometryProfile = {
    hasPoint: false,
    hasLine: false,
    hasPolygon: false,
  };
  if (!data) return profile;

  const cached = geometryProfileCache.get(data);
  if (cached) return { ...cached };

  if (isGeoArrowBatch(data)) {
    const t = data.geometryType;
    if (t === "Point" || t === "MultiPoint") profile.hasPoint = true;
    if (t === "LineString" || t === "MultiLineString") profile.hasLine = true;
    if (t === "Polygon" || t === "MultiPolygon") profile.hasPolygon = true;
    geometryProfileCache.set(data, { ...profile });
    return profile;
  }

  for (const feature of data.features ?? []) {
    const geometry = feature.geometry;
    if (geometry) {
      addGeometryToProfile(profile, geometry);
      if (profile.hasPoint && profile.hasLine && profile.hasPolygon) break;
    }
  }
  geometryProfileCache.set(data, { ...profile });
  return profile;
}

/**
 * Record a geometry's kinds on a profile, descending into (nested) collections.
 *
 * @param profile - The profile to update in place.
 * @param geometry - The geometry to inspect.
 */
function addGeometryToProfile(profile: GeometryProfile, geometry: Geometry): void {
  const type = geometry.type;
  if (type === "Point" || type === "MultiPoint") profile.hasPoint = true;
  if (type === "LineString" || type === "MultiLineString") profile.hasLine = true;
  if (type === "Polygon" || type === "MultiPolygon") profile.hasPolygon = true;
  if (type === "GeometryCollection") {
    for (const member of geometry.geometries ?? []) addGeometryToProfile(profile, member);
  }
}

/**
 * A layer's extent as `[west, south, east, north]`, for fitting the camera.
 *
 * A GeoJSON layer that crosses the antimeridian gets the narrow extent across
 * it with `east > 180` (see `antimeridianAwareBbox`); combine several with
 * `unionLonLatExtents` rather than a plain min/max.
 *
 * @param layer - The layer to measure.
 * @returns The extent, or null when the layer has none.
 */
export function getLayerBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
  // A layer that loads by viewport (an ArcGIS feature layer) holds only the
  // features in view, so their extent is the view, not the layer: prefer the
  // service extent it stored.
  if (layer.metadata.viewportLoading === true) {
    const stored = storedLayerBounds(layer);
    if (stored) return stored;
  }
  if (layer.geoarrow) {
    const box = computeGeoArrowBBox(layer.geoarrow);
    if (box) return box;
  }
  if (layer.geojson?.features?.length) {
    // A collection whose features all carry a null geometry (e.g. a delimited
    // text file imported as an attribute table, or a non-spatial SQL result)
    // has no extent, and one that carries its own 3D `bbox` member holds six
    // values. `antimeridianAwareBbox` answers null to the first and trims the
    // second; either way, continue to the stored extent rather than flying to
    // invalid coordinates.
    //
    // The extent takes the short way round the antimeridian: a layer with
    // features on both sides of it (Alaska's Aleutians, Fiji, Pacific
    // earthquakes) reads as the narrow band across it, unwrapped to `east > 180`
    // the way MapLibre's own bounds are, rather than as the whole globe
    // (GeoLibre#3469). A consumer that needs RFC 7946 longitudes converts with
    // `toRfc7946Bbox`.
    const box = antimeridianAwareBbox(layer.geojson);
    if (box) return box;
  }
  return storedLayerBounds(layer);
}

/** The layer's advertised `source.bounds` or `metadata.bounds`, if well-formed. */
function storedLayerBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
  for (const value of [layer.source.bounds, layer.metadata.bounds]) {
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
    ) {
      return value as [number, number, number, number];
    }
  }
  return null;
}

export * from "./style-layer-ids";
