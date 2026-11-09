import { featureSelectionId, useAppStore } from "@geolibre/core";
import buffer from "@turf/buffer";
import union from "@turf/union";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/**
 * Search areas for STAC Item Search beyond a bounding box: a point, a line, a polygon, the
 * features selected in a layer, or the contents of a file. Each is reduced to one GeoJSON geometry,
 * which is what the `intersects` parameter takes.
 *
 * The merge rules match the Kentucky STAC QGIS plugin and the ArcGIS Pro add-ins, so the same
 * selection searches the same area in all three.
 */

/** Positions beyond this make a request body large enough that servers refuse it. */
export const AOI_MAX_POSITIONS = 20_000;

type Base = "Point" | "LineString" | "Polygon";
const MULTI: Record<Base, "MultiPoint" | "MultiLineString" | "MultiPolygon"> = {
  Point: "MultiPoint",
  LineString: "MultiLineString",
  Polygon: "MultiPolygon",
};

/** Highest dimension first: when kinds are mixed, the search uses the highest present. */
const DIMENSION: Base[] = ["Polygon", "LineString", "Point"];

/** Eight decimals, as the QGIS and ArcGIS Pro tools send: about a millimetre. */
function round(position: Position): Position {
  return [Math.round(position[0] * 1e8) / 1e8, Math.round(position[1] * 1e8) / 1e8];
}

/** Single-part geometries, with multi-part ones taken apart and collections flattened. */
function parts(geometry: Geometry): Array<{ type: Base; coordinates: unknown }> {
  switch (geometry.type) {
    case "Point":
    case "LineString":
    case "Polygon":
      return [{ type: geometry.type, coordinates: geometry.coordinates }];
    case "MultiPoint":
      return geometry.coordinates.map((coordinates) => ({ type: "Point", coordinates }));
    case "MultiLineString":
      return geometry.coordinates.map((coordinates) => ({ type: "LineString", coordinates }));
    case "MultiPolygon":
      return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
    case "GeometryCollection":
      return geometry.geometries.flatMap(parts);
  }
}

function roundCoordinates(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === "number") return round(value as Position);
  return value.map(roundCoordinates);
}

function roundGeometry(geometry: Geometry): Geometry {
  if (geometry.type === "GeometryCollection") {
    return { ...geometry, geometries: geometry.geometries.map(roundGeometry) };
  }
  return { ...geometry, coordinates: roundCoordinates(geometry.coordinates) } as Geometry;
}

/** How many positions a geometry carries, for refusing one too large to send. */
export function countPositions(geometry: Geometry): number {
  const count = (value: unknown): number => {
    if (!Array.isArray(value)) return 0;
    if (typeof value[0] === "number") return 1;
    return value.reduce<number>((sum, child) => sum + count(child), 0);
  };
  return parts(geometry).reduce((sum, part) => sum + count(part.coordinates), 0);
}

/** A search geometry, and how many inputs of a lower dimension it left out. */
export interface MergedArea {
  geometry: Geometry;
  ignored: number;
}

/** Unions polygons into one valid geometry, or undefined when the union cannot be computed. */
function dissolve(polygons: Position[][][]): Geometry | undefined {
  try {
    const merged = union({
      type: "FeatureCollection",
      features: polygons.map((coordinates) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates },
      })),
    });
    return merged ? roundGeometry(merged.geometry) : undefined;
  } catch {
    // An unrepairable input should not block the search; the caller falls back to a MultiPolygon.
    return undefined;
  }
}

/**
 * Merges geometries into one search area. Only the highest dimension present is kept (polygon,
 * then line, then point) and the lower-dimension inputs are counted so the panel can say so.
 * Polygons are dissolved, so overlapping ones give a valid geometry; lines and points become the
 * matching Multi geometry.
 *
 * @returns The merged area, or undefined when there is nothing to merge.
 */
export function mergeGeometries(
  geometries: Array<Geometry | null | undefined>,
): MergedArea | undefined {
  const all = geometries.flatMap((geometry) => (geometry ? parts(geometry) : []));
  const kind = DIMENSION.find((type) => all.some((part) => part.type === type));
  if (!kind) return undefined;
  const chosen = all
    .filter((part) => part.type === kind)
    .map((part) => roundCoordinates(part.coordinates));
  const ignored = all.length - chosen.length;
  if (kind === "Polygon" && chosen.length > 1) {
    const dissolved = dissolve(chosen as Position[][][]);
    if (dissolved) return { geometry: dissolved, ignored };
  }
  const geometry =
    chosen.length === 1
      ? ({ type: kind, coordinates: chosen[0] } as Geometry)
      : ({ type: MULTI[kind], coordinates: chosen } as Geometry);
  return { geometry, ignored };
}

/** Whether a geometry is a point or a line, which has no area of its own to search. */
export function isBufferable(geometry: Geometry): boolean {
  return (
    geometry.type === "Point" ||
    geometry.type === "MultiPoint" ||
    geometry.type === "LineString" ||
    geometry.type === "MultiLineString"
  );
}

/**
 * Widens a point or line into a polygon `kilometers` either side, so a search finds the scenes
 * near it and not only those that happen to cover it. A polygon is returned as it is.
 *
 * @param geometry - The shape the user gave.
 * @param kilometers - The distance to widen by; zero or less leaves the shape alone.
 * @returns The buffered geometry, or the original when it has no area to widen or buffering fails.
 */
export function bufferGeometry(geometry: Geometry, kilometers: number): Geometry {
  if (!isBufferable(geometry) || !(kilometers > 0)) return geometry;
  try {
    const widened = buffer({ type: "Feature", properties: {}, geometry }, kilometers, {
      units: "kilometers",
    });
    return widened ? roundGeometry(widened.geometry) : geometry;
  } catch {
    return geometry;
  }
}

/** The merged area of GeoJSON in any of its three top-level shapes. */
export function geometryOfGeoJson(value: unknown): MergedArea | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const node = value as { type?: unknown; features?: unknown; geometry?: unknown };
  if (node.type === "FeatureCollection" && Array.isArray(node.features)) {
    return mergeGeometries((node.features as Feature[]).map((feature) => feature?.geometry));
  }
  if (node.type === "Feature") return mergeGeometries([node.geometry as Geometry | null]);
  if (typeof node.type === "string") return mergeGeometries([value as Geometry]);
  return undefined;
}

/**
 * The merged area of the features selected in the Layers panel's selected layer.
 *
 * @returns The area, or undefined when nothing is selected or the selection has no geometry.
 */
export function selectedFeaturesGeometry(): MergedArea | undefined {
  const { layers, selectedLayerId, selectedFeatureIds } = useAppStore.getState();
  if (!selectedLayerId || !selectedFeatureIds.length) return undefined;
  const layer = layers.find((candidate) => candidate.id === selectedLayerId);
  const features = layer?.geojson?.features;
  if (!features) return undefined;
  const chosen = new Set(selectedFeatureIds);
  return mergeGeometries(
    features.flatMap((feature, index) =>
      chosen.has(featureSelectionId(feature, index)) ? [feature.geometry] : [],
    ),
  );
}

/**
 * Reads a search area from a file: GeoJSON (`.geojson`, `.json`) or a zipped shapefile (`.zip`).
 *
 * @param file - The file the user chose.
 * @returns The merged area of everything in the file.
 * @throws When the file is neither, or holds no geometry.
 */
export async function geometryFromFile(file: File): Promise<MergedArea> {
  const name = file.name.toLowerCase();
  let parsed: unknown;
  if (name.endsWith(".zip")) {
    const { default: shp } = await import("shpjs");
    parsed = await shp(await file.arrayBuffer());
  } else if (/\.(geo)?json$/.test(name)) {
    parsed = JSON.parse(await file.text());
  } else {
    throw new Error("Choose a GeoJSON file or a zipped shapefile.");
  }
  // shpjs returns an array when an archive holds several layers.
  const collections = (Array.isArray(parsed) ? parsed : [parsed]) as FeatureCollection[];
  const area = mergeGeometries(
    collections.flatMap((collection) => {
      const merged = geometryOfGeoJson(collection);
      return merged ? [merged.geometry] : [];
    }),
  );
  if (!area) throw new Error("The file holds no geometry to search with.");
  return area;
}
