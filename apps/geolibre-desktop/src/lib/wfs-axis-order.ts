// Axis-order repair for GeoJSON from ArcGIS WFS endpoints.
//
// GeoJSON is lon/lat by definition, but an ArcGIS Server `…/WFSServer` asked
// for WFS 1.1 / 2.0 GeoJSON in EPSG:4326 writes it lat/lon (EPSG axis order),
// labels it `EPSG:4326` either way, and an administrator can switch the
// service to lon/lat, so neither the response nor the server type says which
// order arrived. The data decides: a coordinate that is only valid one way
// round settles it, and otherwise the extent is compared with the feature
// type's WGS84BoundingBox from GetCapabilities, which OWS fixes as lon/lat.
// Other WFS servers write GeoJSON lon/lat and are left alone.

import type { FeatureCollection, Geometry, Position } from "geojson";
import { parseEpsgSrsName } from "./gml";

/** `[minX, minY, maxX, maxY]` in the order the coordinates were written. */
export type Extent = [number, number, number, number];

/** The parts of an ArcGIS GetFeature request the axis check needs. */
export interface ArcGisWfsRequest {
  capabilitiesUrl: string;
  typeName: string;
}

// Latitude-first geographic CRSs a WFS request commonly names; the same set
// gml.ts treats as WGS84.
const GEOGRAPHIC_CODES = new Set([4326, 4258, 4269]);
// GetFeature parameters dropped when turning the request into GetCapabilities;
// anything else (an ArcGIS token, say) is kept.
const OPERATION_PARAMS = new Set([
  "service",
  "request",
  "version",
  "typename",
  "typenames",
  "outputformat",
  "srsname",
  "count",
  "maxfeatures",
  "bbox",
  "resulttype",
  "startindex",
]);

/**
 * The ArcGIS GetFeature request behind `url` when its GeoJSON may be lat/lon:
 * a `…/WFSServer` endpoint, WFS 1.1 or 2.0, and a latitude-first geographic
 * `srsName`. Null for anything else.
 *
 * @param url - The GetFeature URL.
 * @returns The capabilities URL and type name to check against, or null.
 */
export function arcGisAxisCheckRequest(url: string): ArcGisWfsRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/\/WFSServer\/?$/i.test(parsed.pathname)) return null;
  const params = new Map<string, string>();
  for (const [key, value] of parsed.searchParams) params.set(key.toLowerCase(), value);
  if (params.get("request")?.toLowerCase() !== "getfeature") return null;
  const version = params.get("version") ?? "";
  if (!version.startsWith("2") && !version.startsWith("1.1")) return null;
  const srs = parseEpsgSrsName(params.get("srsname") ?? "");
  if (!srs || !GEOGRAPHIC_CODES.has(srs.code)) return null;
  const typeName = params.get("typenames") ?? params.get("typename");
  if (!typeName) return null;

  const capabilities = new URL(parsed.toString());
  for (const key of Array.from(capabilities.searchParams.keys())) {
    if (OPERATION_PARAMS.has(key.toLowerCase())) capabilities.searchParams.delete(key);
  }
  capabilities.searchParams.set("SERVICE", "WFS");
  capabilities.searchParams.set("REQUEST", "GetCapabilities");
  capabilities.searchParams.set("VERSION", version);
  return { capabilitiesUrl: capabilities.toString(), typeName };
}

/**
 * The extent of every position in a collection, or null when it has none.
 *
 * @param collection - The features.
 * @returns The extent in the order the coordinates were written.
 */
export function coordinateExtent(collection: FeatureCollection): Extent | null {
  const extent: Extent = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (position: Position) => {
    const [x, y] = position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    extent[0] = Math.min(extent[0], x);
    extent[1] = Math.min(extent[1], y);
    extent[2] = Math.max(extent[2], x);
    extent[3] = Math.max(extent[3], y);
  };
  for (const feature of collection.features) forEachPosition(feature.geometry, visit);
  return Number.isFinite(extent[0]) ? extent : null;
}

/**
 * Decide whether coordinates arrived lat/lon.
 *
 * @param extent - The data extent as written.
 * @param bbox - The feature type's WGS84 box (`[minLon, minLat, maxLon,
 *   maxLat]`), or null when unknown.
 * @returns True to swap every position's first two ordinates.
 */
export function shouldSwapAxes(extent: Extent, bbox: Extent | null): boolean {
  const { validAsIs, validSwapped } = validity(extent);
  if (validAsIs !== validSwapped) return validSwapped;
  if (!validAsIs || !bbox) return false;
  const [minX, minY, maxX, maxY] = extent;
  return fits([minY, minX, maxY, maxX], bbox) && !fits(extent, bbox);
}

/**
 * Whether the coordinates are valid lon/lat both as written and swapped, so
 * only the capabilities bounding box can tell the order apart.
 *
 * @param extent - The data extent as written.
 * @returns True when {@link shouldSwapAxes} needs the bounding box.
 */
export function axisOrderIsAmbiguous(extent: Extent): boolean {
  const { validAsIs, validSwapped } = validity(extent);
  return validAsIs && validSwapped;
}

function validity([minX, minY, maxX, maxY]: Extent) {
  const within = (value: number, limit: number) => Math.abs(value) <= limit;
  return {
    validAsIs:
      [minX, maxX].every((v) => within(v, 180)) && [minY, maxY].every((v) => within(v, 90)),
    validSwapped:
      [minX, maxX].every((v) => within(v, 90)) && [minY, maxY].every((v) => within(v, 180)),
  };
}

// Whether a lon/lat extent lies inside the box, with a margin for servers whose
// advertised box is rounded or slightly stale.
function fits(extent: Extent, bbox: Extent): boolean {
  const margin = Math.max(0.5, 0.05 * Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]));
  return (
    extent[0] >= bbox[0] - margin &&
    extent[1] >= bbox[1] - margin &&
    extent[2] <= bbox[2] + margin &&
    extent[3] <= bbox[3] + margin
  );
}

/**
 * The WGS84BoundingBox a WFS 1.1 / 2.0 capabilities document gives a feature
 * type, matched on its name case-insensitively and with or without a prefix.
 *
 * @param capabilities - The GetCapabilities XML.
 * @param typeName - The requested type name.
 * @returns `[minLon, minLat, maxLon, maxLat]`, or null when absent.
 */
export function wgs84BoundingBox(capabilities: string, typeName: string): Extent | null {
  const document = new DOMParser().parseFromString(capabilities, "application/xml");
  const wanted = typeName.toLowerCase();
  const bare = (name: string) => name.toLowerCase().replace(/^.*:/, "");
  const child = (element: Element | undefined, name: string) =>
    element ? childElements(element).find((candidate) => localName(candidate) === name) : undefined;
  for (const featureType of descendants(document.documentElement, "FeatureType")) {
    const name = child(featureType, "Name")?.textContent?.trim() ?? "";
    if (name.toLowerCase() !== wanted && bare(name) !== bare(wanted)) continue;
    const box = child(featureType, "WGS84BoundingBox");
    const corner = (which: string) =>
      (child(box, which)?.textContent ?? "").trim().split(/\s+/).map(Number);
    const [minLon, minLat] = corner("LowerCorner");
    const [maxLon, maxLat] = corner("UpperCorner");
    const extent: Extent = [minLon, minLat, maxLon, maxLat];
    return extent.every(Number.isFinite) ? extent : null;
  }
  return null;
}

/**
 * Swap the first two ordinates of every position, in place.
 *
 * @param collection - The features to repair.
 * @returns The same collection.
 */
export function swapAxes(collection: FeatureCollection): FeatureCollection {
  for (const feature of collection.features) {
    forEachPosition(feature.geometry, (position) => {
      const [first, second] = position;
      position[0] = second;
      position[1] = first;
    });
  }
  return collection;
}

function forEachPosition(geometry: Geometry | null, visit: (position: Position) => void): void {
  if (!geometry) return;
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(visit);
      return;
    case "MultiLineString":
    case "Polygon":
      geometry.coordinates.forEach((line) => line.forEach(visit));
      return;
    case "MultiPolygon":
      geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(visit)));
      return;
    case "GeometryCollection":
      geometry.geometries.forEach((child) => forEachPosition(child, visit));
  }
}

// Element children and descendants through childNodes, which every DOM
// (browsers, and linkedom in tests) implements the same way for XML.
function childElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}

function descendants(root: Element | null, name: string): Element[] {
  const found: Element[] = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const element = stack.pop()!;
    if (localName(element) === name) found.push(element);
    else stack.push(...childElements(element).reverse());
  }
  return found;
}

function localName(element: Element): string {
  return (element.localName || element.nodeName).replace(/^.*:/, "");
}
