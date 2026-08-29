import bbox from "@turf/bbox";
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";

export type GeometryKind = "point" | "line" | "polygon";

export interface GeometryProfile {
  hasPoint: boolean;
  hasLine: boolean;
  hasPolygon: boolean;
}

export function detectGeometryProfile(fc: FeatureCollection): GeometryProfile {
  const profile: GeometryProfile = {
    hasPoint: false,
    hasLine: false,
    hasPolygon: false,
  };
  for (const feature of fc.features) {
    const type = feature.geometry?.type;
    if (!type) continue;
    if (type === "Point" || type === "MultiPoint") profile.hasPoint = true;
    if (type === "LineString" || type === "MultiLineString") {
      profile.hasLine = true;
    }
    if (type === "Polygon" || type === "MultiPolygon") {
      profile.hasPolygon = true;
    }
    if (type === "GeometryCollection") {
      for (const g of feature.geometry.geometries) {
        if (g.type === "Point" || g.type === "MultiPoint") profile.hasPoint = true;
        if (g.type === "LineString" || g.type === "MultiLineString") profile.hasLine = true;
        if (g.type === "Polygon" || g.type === "MultiPolygon") profile.hasPolygon = true;
      }
    }
  }
  return profile;
}

export function getLayerBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
  if (layer.geojson?.features?.length) {
    const box = bbox(layer.geojson);
    // A collection whose features all carry a null geometry (e.g. a delimited
    // text file imported as an attribute table, or a non-spatial SQL result)
    // yields a degenerate ±Infinity box. Continue to the stored extent in
    // that case instead of flying to invalid coordinates.
    if (box.every((value) => Number.isFinite(value))) {
      return box as [number, number, number, number];
    }
  }
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
