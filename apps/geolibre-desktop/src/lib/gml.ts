// GML feature-collection parsing for WFS GetFeature responses (issue #2746).
//
// Many WFS servers (MapServer without an OGR output format, most INSPIRE
// services) only answer GetFeature in GML, which the GeoJSON-only loader could
// not read. This converts a GML 2 / 3.1 / 3.2 feature collection into a GeoJSON
// FeatureCollection in lon/lat order, in the browser, with no GDAL.
//
// Scope: the simple-features geometry profile WFS servers emit (points, lines,
// polygons, their multi forms, curves and surfaces made of linear segments).
// Elements are matched by local name so every GML and WFS namespace version
// works. Coordinates are normalized to WGS84 lon/lat: EPSG axis order is
// honored for URN / URL CRS names (so `urn:ogc:def:crs:EPSG::4326` is read as
// lat/lon), Web Mercator is unprojected, and any other CRS is rejected with a
// message naming it, because drawing projected metres as degrees would put the
// features in the wrong place without any error.
//
// Uses the global DOMParser (a browser API; tests install linkedom's).

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/** Raised when a GML document uses a CRS this parser cannot convert to lon/lat. */
export class GmlUnsupportedCrsError extends Error {
  readonly srsName: string;
  constructor(srsName: string) {
    super(
      `The service returned features in ${srsName}, which cannot be shown without reprojection. Request them in EPSG:4326 instead (set the SRS name).`,
    );
    this.name = "GmlUnsupportedCrsError";
    this.srsName = srsName;
  }
}

/** Options for {@link parseGmlFeatureCollection}. */
export interface GmlParseOptions {
  /**
   * CRS to assume for geometries that carry no `srsName` themselves or on an
   * enclosing geometry, typically the `srsName` the GetFeature request asked
   * for. Unset (and absent from the document) means lon/lat.
   */
  defaultSrsName?: string;
}

type CoordinateTransform = (position: Position) => Position;

const EARTH_RADIUS = 6378137;
// Geographic CRSs close enough to WGS84 for display (sub-metre to ~1 m apart):
// WGS84, ETRS89 (the INSPIRE default), NAD83.
const GEOGRAPHIC_EPSG_CODES = new Set(["4326", "4258", "4269"]);
const WEB_MERCATOR_EPSG_CODES = new Set(["3857", "900913", "3785", "102100", "102113"]);

// Feature-wrapper elements across WFS 1.x (gml:featureMember[s]) and 2.0
// (wfs:member). wfs:additionalObjects / wfs:truncatedResponse are skipped.
const MEMBER_NAMES = new Set(["featureMember", "member"]);
const MEMBERS_NAMES = new Set(["featureMembers"]);
// GML-standard feature properties that are not attributes worth keeping.
const SKIPPED_PROPERTY_NAMES = new Set(["boundedBy", "location"]);
const GEOMETRY_NAMES = new Set([
  "Point",
  "LineString",
  "LinearRing",
  "Polygon",
  "Curve",
  "Surface",
  "MultiPoint",
  "MultiLineString",
  "MultiCurve",
  "MultiPolygon",
  "MultiSurface",
  "MultiGeometry",
  "Envelope",
  "Box",
]);
// A bare number with no leading zero (so codes like "0201" stay strings).
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * True when an XML response body is a GML feature collection rather than an
 * OWS exception report or some other XML document.
 *
 * @param text - The response body.
 * @returns Whether the document's root is a `FeatureCollection` element.
 */
export function looksLikeGmlFeatureCollection(text: string): boolean {
  // Skip the prolog, comments and processing instructions to the root tag.
  const root = /<(?![?!])(?:[\w.-]+:)?([\w.-]+)/.exec(text.slice(0, 4096));
  return root?.[1] === "FeatureCollection";
}

/**
 * Parse a WFS GetFeature GML response into a GeoJSON FeatureCollection.
 *
 * @param text - The GML document.
 * @param options - Parsing options (the CRS to assume when none is stated).
 * @returns The features, with coordinates in WGS84 lon/lat.
 * @throws {Error} When the document is not well-formed XML or not a feature
 *   collection, or {@link GmlUnsupportedCrsError} for a CRS it cannot convert.
 */
export function parseGmlFeatureCollection(
  text: string,
  options: GmlParseOptions = {},
): FeatureCollection {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const root = document.documentElement;
  if (!root || document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The service returned malformed GML.");
  }
  if (localName(root) !== "FeatureCollection") {
    throw new Error("The GML response is not a feature collection.");
  }

  const features: Feature[] = [];
  for (const featureElement of featureElements(root)) {
    features.push(parseFeature(featureElement, options.defaultSrsName));
  }
  typeAttributeColumns(features);
  return { type: "FeatureCollection", features };
}

// GML without its schema carries every attribute as text. Convert a column to
// numbers (or booleans) only when every non-null value in it qualifies, so a
// zero-padded code column ("08", "32") stays uniformly text instead of mixing
// strings and numbers, which would break filters, sorting and styling.
function typeAttributeColumns(features: Feature[]): void {
  const numeric = new Map<string, boolean>();
  const boolean = new Map<string, boolean>();
  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (typeof value !== "string") continue;
      numeric.set(key, (numeric.get(key) ?? true) && NUMBER_PATTERN.test(value));
      boolean.set(key, (boolean.get(key) ?? true) && (value === "true" || value === "false"));
    }
  }
  for (const feature of features) {
    const properties = feature.properties;
    if (!properties) continue;
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value !== "string") continue;
      if (numeric.get(key)) properties[key] = Number(value);
      else if (boolean.get(key)) properties[key] = value === "true";
    }
  }
}

function featureElements(root: Element): Element[] {
  const result: Element[] = [];
  for (const child of childElements(root)) {
    const name = localName(child);
    if (MEMBER_NAMES.has(name)) {
      const feature = childElements(child)[0];
      // A WFS 2.0 join result wraps several features in wfs:Tuple; keep the
      // first so the member still yields one feature.
      if (feature && localName(feature) === "Tuple") {
        const first = childElements(feature)[0];
        const inner = first ? childElements(first)[0] : undefined;
        if (inner) result.push(inner);
      } else if (feature) {
        result.push(feature);
      }
    } else if (MEMBERS_NAMES.has(name)) {
      result.push(...childElements(child));
    }
  }
  return result;
}

function parseFeature(element: Element, defaultSrsName: string | undefined): Feature {
  const properties: Record<string, unknown> = {};
  let geometry: Geometry | null = null;

  for (const child of childElements(element)) {
    const name = localName(child);
    if (SKIPPED_PROPERTY_NAMES.has(name) && isGmlNamespace(child)) continue;

    const geometryElement = childElements(child).find(isGeometryElement);
    if (geometryElement) {
      // The first geometry property is the feature's geometry; later ones
      // (a label point next to a polygon, say) have no GeoJSON slot.
      if (!geometry) geometry = parseGeometry(geometryElement, defaultSrsName);
      continue;
    }
    properties[name] = propertyValue(child);
  }

  const id = featureId(element);
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    properties,
    geometry: geometry as Geometry,
  };
}

function featureId(element: Element): string | undefined {
  return attributeByLocalName(element, "id") || element.getAttribute("fid") || undefined;
}

function propertyValue(element: Element): unknown {
  if (attributeByLocalName(element, "nil") === "true") return null;
  const href = attributeByLocalName(element, "href");
  const children = childElements(element);
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (children.length === 0 && !text && href) return href;
  // Complex (nested) properties flatten to their text; a map style or the
  // attribute table can only use scalars anyway. Typing happens per column
  // afterwards (typeAttributeColumns).
  return text || null;
}

// --- Geometry --------------------------------------------------------------

function parseGeometry(element: Element, inheritedSrsName: string | undefined): Geometry | null {
  const srsName = element.getAttribute("srsName") || inheritedSrsName;
  const transform = coordinateTransform(srsName);
  const dimension = srsDimension(element);
  return readGeometry(element, transform, dimension, srsName);
}

function readGeometry(
  element: Element,
  transform: CoordinateTransform,
  dimension: number,
  srsName: string | undefined,
): Geometry | null {
  // A nested geometry can restate its own CRS; honor it.
  const ownSrs = element.getAttribute("srsName");
  if (ownSrs && ownSrs !== srsName) {
    return readGeometry(
      element,
      coordinateTransform(ownSrs),
      srsDimension(element, dimension),
      ownSrs,
    );
  }
  const dim = srsDimension(element, dimension);
  const line = (el: Element) => readPositions(el, dim).map(transform);

  switch (localName(element)) {
    case "Point": {
      const position = readPositions(element, dim)[0];
      return position ? { type: "Point", coordinates: transform(position) } : null;
    }
    case "LineString":
      return { type: "LineString", coordinates: line(element) };
    case "Curve":
      return { type: "LineString", coordinates: curvePositions(element, dim).map(transform) };
    case "LinearRing":
      return { type: "Polygon", coordinates: [line(element)] };
    case "Polygon":
      return { type: "Polygon", coordinates: polygonRings(element, dim, transform) };
    case "Surface": {
      const polygons = surfacePolygons(element, dim, transform);
      if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
      return { type: "MultiPolygon", coordinates: polygons };
    }
    case "Envelope":
    case "Box":
      return envelopePolygon(element, dim, transform);
    case "MultiPoint": {
      const points = memberGeometries(element, transform, dim, srsName).flatMap((geometry) =>
        geometry.type === "Point" ? [geometry.coordinates] : [],
      );
      return { type: "MultiPoint", coordinates: points };
    }
    case "MultiLineString":
    case "MultiCurve": {
      const lines = memberGeometries(element, transform, dim, srsName).flatMap((geometry) =>
        geometry.type === "LineString"
          ? [geometry.coordinates]
          : geometry.type === "MultiLineString"
            ? geometry.coordinates
            : [],
      );
      return { type: "MultiLineString", coordinates: lines };
    }
    case "MultiPolygon":
    case "MultiSurface": {
      const polygons = memberGeometries(element, transform, dim, srsName).flatMap((geometry) =>
        geometry.type === "Polygon"
          ? [geometry.coordinates]
          : geometry.type === "MultiPolygon"
            ? geometry.coordinates
            : [],
      );
      return { type: "MultiPolygon", coordinates: polygons };
    }
    case "MultiGeometry":
      return {
        type: "GeometryCollection",
        geometries: memberGeometries(element, transform, dim, srsName),
      };
    default:
      return null;
  }
}

// Children of a multi-geometry: `*Member` (one geometry each) and `*Members`
// (several) wrappers, in document order.
function memberGeometries(
  element: Element,
  transform: CoordinateTransform,
  dimension: number,
  srsName: string | undefined,
): Geometry[] {
  const geometries: Geometry[] = [];
  for (const wrapper of childElements(element)) {
    if (!/Members?$/.test(localName(wrapper))) continue;
    for (const child of childElements(wrapper)) {
      if (!isGeometryElement(child)) continue;
      const geometry = readGeometry(child, transform, dimension, srsName);
      if (geometry) geometries.push(geometry);
    }
  }
  return geometries;
}

function polygonRings(
  element: Element,
  dimension: number,
  transform: CoordinateTransform,
): Position[][] {
  const rings: Position[][] = [];
  for (const boundary of childElements(element)) {
    const name = localName(boundary);
    if (!["exterior", "interior", "outerBoundaryIs", "innerBoundaryIs"].includes(name)) continue;
    const ring = childElements(boundary)[0];
    if (!ring) continue;
    const positions = ringPositions(ring, dimension).map(transform);
    if (positions.length === 0) continue;
    if (name === "exterior" || name === "outerBoundaryIs") rings.unshift(positions);
    else rings.push(positions);
  }
  return rings;
}

// A LinearRing, or a gml:Ring made of curveMember curves.
function ringPositions(ring: Element, dimension: number): Position[] {
  if (localName(ring) !== "Ring") return readPositions(ring, dimension);
  const positions: Position[] = [];
  for (const member of childElements(ring)) {
    for (const curve of childElements(member)) {
      appendPath(
        positions,
        localName(curve) === "Curve"
          ? curvePositions(curve, dimension)
          : readPositions(curve, dimension),
      );
    }
  }
  return positions;
}

// gml:Curve → segments → LineStringSegment / Arc / ...: the control points in
// order. Arcs are drawn through their control points, not densified.
function curvePositions(curve: Element, dimension: number): Position[] {
  const positions: Position[] = [];
  const segments = childElements(curve).find((child) => localName(child) === "segments");
  for (const segment of segments ? childElements(segments) : []) {
    appendPath(positions, readPositions(segment, srsDimension(segment, dimension)));
  }
  return positions;
}

function surfacePolygons(
  surface: Element,
  dimension: number,
  transform: CoordinateTransform,
): Position[][][] {
  const patches = childElements(surface).find((child) =>
    /^(patches|polygonPatches)$/.test(localName(child)),
  );
  return (patches ? childElements(patches) : [])
    .map((patch) => polygonRings(patch, srsDimension(patch, dimension), transform))
    .filter((rings) => rings.length > 0);
}

function envelopePolygon(
  element: Element,
  dimension: number,
  transform: CoordinateTransform,
): Geometry | null {
  let corners: Position[];
  if (localName(element) === "Box") {
    corners = readPositions(element, dimension);
  } else {
    const lower = childElements(element).find((child) => localName(child) === "lowerCorner");
    const upper = childElements(element).find((child) => localName(child) === "upperCorner");
    corners = [lower, upper]
      .map((corner) => parseNumbers(corner?.textContent))
      .filter((position) => position.length >= 2);
  }
  if (corners.length < 2) return null;
  const [minX, minY] = transform(corners[0]);
  const [maxX, maxY] = transform(corners[1]);
  return {
    type: "Polygon",
    coordinates: [
      [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY],
      ],
    ],
  };
}

// Joins consecutive segments, dropping a start point that repeats the previous
// segment's end.
function appendPath(target: Position[], positions: Position[]): void {
  const last = target[target.length - 1];
  const first = positions[0];
  const skip = last && first && last.every((value, index) => value === first[index]) ? 1 : 0;
  for (let index = skip; index < positions.length; index += 1) target.push(positions[index]);
}

// --- Coordinates -----------------------------------------------------------

// The positions directly under a geometry element, in whichever encoding it
// uses: posList, a run of pos / pointProperty, GML 2 coordinates, or coord.
function readPositions(element: Element, dimension: number): Position[] {
  const children = childElements(element);
  const posList = children.find((child) => localName(child) === "posList");
  if (posList) {
    return chunk(parseNumbers(posList.textContent), srsDimension(posList, dimension));
  }
  const coordinates = children.find((child) => localName(child) === "coordinates");
  if (coordinates) return parseGml2Coordinates(coordinates);

  const positions: Position[] = [];
  for (const child of children) {
    const name = localName(child);
    if (name === "pos") {
      const values = parseNumbers(child.textContent);
      if (values.length >= 2) positions.push(values);
    } else if (name === "coord") {
      const values = ["X", "Y", "Z"]
        .map((axis) => childElements(child).find((c) => localName(c) === axis)?.textContent)
        .filter((value): value is string => value != null)
        .map(Number);
      if (values.length >= 2) positions.push(values);
    } else if (name === "pointProperty" || name === "pointRep") {
      const point = childElements(child).find((c) => localName(c) === "Point");
      if (point) positions.push(...readPositions(point, dimension));
    }
  }
  return positions;
}

function parseGml2Coordinates(element: Element): Position[] {
  const decimal = element.getAttribute("decimal") || ".";
  const cs = element.getAttribute("cs") || ",";
  const ts = element.getAttribute("ts") || " ";
  const text = (element.textContent ?? "").trim();
  if (!text) return [];
  const tuples = ts.trim() === "" ? text.split(/\s+/) : text.split(ts).map((part) => part.trim());
  return tuples
    .filter(Boolean)
    .map((tuple) =>
      tuple
        .split(cs)
        .map((value) => Number(decimal === "." ? value : value.split(decimal).join("."))),
    )
    .filter((position) => position.length >= 2 && position.every(Number.isFinite));
}

function parseNumbers(text: string | null | undefined): number[] {
  if (!text) return [];
  return text.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

function chunk(values: number[], size: number): Position[] {
  const positions: Position[] = [];
  for (let index = 0; index + size <= values.length; index += size) {
    positions.push(values.slice(index, index + size));
  }
  return positions;
}

function srsDimension(element: Element, fallback = 2): number {
  const value = Number(element.getAttribute("srsDimension") ?? element.getAttribute("dimension"));
  return Number.isInteger(value) && value >= 2 ? value : fallback;
}

// --- CRS -------------------------------------------------------------------

/**
 * Build the transform from a GML `srsName` to GeoJSON lon/lat.
 *
 * URN and `opengis.net/def/crs` names follow the EPSG axis order (lat/lon for
 * geographic CRSs); the legacy `EPSG:4326` and `…/epsg.xml#4326` forms are
 * lon/lat by convention, and so is an absent srsName.
 *
 * @param srsName - The CRS name from the document or the request.
 * @returns A function mapping one position to lon/lat (extra ordinates kept).
 * @throws {GmlUnsupportedCrsError} For a CRS other than WGS84-like geographic
 *   or Web Mercator.
 */
export function coordinateTransform(srsName: string | undefined): CoordinateTransform {
  const identity: CoordinateTransform = (position) => position;
  if (!srsName) return identity;
  const name = srsName.trim();
  if (/CRS:?84$/i.test(name)) return identity;

  const authority =
    /^urn:(?:x-)?ogc:def:crs:EPSG:[^:]*:(\d+)$/i.exec(name) ??
    /^https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/[^/]+\/(\d+)$/i.exec(name);
  const legacy =
    /^EPSG:(\d+)$/i.exec(name) ??
    /^https?:\/\/www\.opengis\.net\/gml\/srs\/epsg\.xml#(\d+)$/i.exec(name);
  const code = (authority ?? legacy)?.[1];
  if (!code) throw new GmlUnsupportedCrsError(name);

  if (GEOGRAPHIC_EPSG_CODES.has(code)) {
    return authority ? ([lat, lon, ...rest]) => [lon, lat, ...rest] : identity;
  }
  if (WEB_MERCATOR_EPSG_CODES.has(code)) {
    return ([x, y, ...rest]) => [
      (x / EARTH_RADIUS) * (180 / Math.PI),
      (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI),
      ...rest,
    ];
  }
  throw new GmlUnsupportedCrsError(name);
}

// --- DOM helpers -----------------------------------------------------------

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}

// Browsers report `localName` without the prefix; strip one anyway so a DOM
// that keeps it (linkedom, in tests) matches the same names.
function localName(element: Element): string {
  return (element.localName || element.nodeName).replace(/^.*:/, "");
}

// An attribute by local name, whatever prefix the document bound its namespace
// to (gml:id, xsi:nil, xlink:href).
function attributeByLocalName(element: Element, name: string): string | undefined {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.replace(/^.*:/, "") === name && attribute.value) return attribute.value;
  }
  return undefined;
}

function isGmlNamespace(element: Element): boolean {
  const namespace = element.namespaceURI ?? "";
  return namespace.startsWith("http://www.opengis.net/gml") || element.nodeName.startsWith("gml:");
}

function isGeometryElement(element: Element): boolean {
  return GEOMETRY_NAMES.has(localName(element));
}
