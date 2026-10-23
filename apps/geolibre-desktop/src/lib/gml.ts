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
// honored for GML 3 positions under URN / URL CRS names (so
// `urn:ogc:def:crs:EPSG::4326` is read as lat/lon), Web Mercator is
// unprojected, and other CRSs go through a caller-supplied resolver
// (gml-projection.ts reprojects any EPSG code). A CRS nothing resolves is
// rejected with a message naming it, because drawing projected metres as
// degrees would put the features in the wrong place without any error.
//
// Uses the global DOMParser (a browser API; tests install linkedom's).

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/** Raised when a GML document uses a CRS this parser cannot convert to lon/lat. */
export class GmlUnsupportedCrsError extends Error {
  readonly srsName: string;
  constructor(srsName: string) {
    super(
      `The service returned features in ${srsName}, which GeoLibre cannot reproject. Request them in EPSG:4326 instead (set the SRS name).`,
    );
    this.name = "GmlUnsupportedCrsError";
    this.srsName = srsName;
  }
}

/**
 * How to read positions in one CRS: whether GML 3 positions are written
 * north-first (EPSG axis order under a URN / URL name) and how to turn an
 * east, north pair into lon/lat. Extra ordinates (height) pass through.
 */
export interface GmlCrs {
  swapAxes: boolean;
  toLonLat: (position: Position) => Position;
}

/** Options for {@link parseGmlFeatureCollection}. */
export interface GmlParseOptions {
  /**
   * CRS to assume for geometries that carry no `srsName` themselves or on an
   * enclosing geometry, typically the `srsName` the GetFeature request asked
   * for. Unset (and absent from the document) means lon/lat.
   */
  defaultSrsName?: string;
  /**
   * CRSs resolved beyond the built-in WGS84-like and Web Mercator ones, keyed
   * by the exact `srsName` the document uses.
   */
  extraCrs?: ReadonlyMap<string, GmlCrs>;
}

type CrsResolver = (srsName: string | undefined) => GmlCrs;

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
): FeatureCollection<Geometry | null> {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const root = document.documentElement;
  if (!root || document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The service returned malformed GML.");
  }
  if (localName(root) !== "FeatureCollection") {
    throw new Error("The GML response is not a feature collection.");
  }

  const resolve: CrsResolver = (srsName) =>
    (srsName && options.extraCrs?.get(srsName.trim())) || resolveGmlCrs(srsName);
  const features: Feature<Geometry | null>[] = [];
  for (const featureElement of featureElements(root)) {
    features.push(parseFeature(featureElement, options.defaultSrsName, resolve));
  }
  typeAttributeColumns(features);
  return { type: "FeatureCollection", features };
}

// GML without its schema carries every attribute as text. Convert a column to
// numbers (or booleans) only when every non-null value in it qualifies, so a
// zero-padded code column ("08", "32") stays uniformly text instead of mixing
// strings and numbers, which would break filters, sorting and styling.
function typeAttributeColumns(features: Feature<Geometry | null>[]): void {
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

function parseFeature(
  element: Element,
  defaultSrsName: string | undefined,
  resolve: CrsResolver,
): Feature<Geometry | null> {
  const properties: Record<string, unknown> = {};
  let geometry: Geometry | null = null;

  for (const child of childElements(element)) {
    const name = localName(child);
    if (SKIPPED_PROPERTY_NAMES.has(name) && isGmlNamespace(child)) continue;

    const geometryElement = childElements(child).find(isGeometryElement);
    if (geometryElement) {
      // The first geometry property is the feature's geometry; later ones
      // (a label point next to a polygon, say) have no GeoJSON slot.
      if (!geometry) geometry = parseGeometry(geometryElement, defaultSrsName, resolve);
      continue;
    }
    properties[name] = propertyValue(child);
  }

  // A feature with no (or an empty) geometry keeps a null geometry, as GeoJSON
  // allows: a WFS may publish attribute-only feature types.
  const id = featureId(element);
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    properties,
    geometry,
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

function parseGeometry(
  element: Element,
  inheritedSrsName: string | undefined,
  resolve: CrsResolver,
): Geometry | null {
  const srsName = element.getAttribute("srsName") || inheritedSrsName;
  const geometry = readGeometry(
    element,
    { crs: resolve(srsName), srsName, resolve },
    srsDimension(element),
  );
  return geometry && !isEmptyGeometry(geometry) ? geometry : null;
}

function isEmptyGeometry(geometry: Geometry): boolean {
  if (geometry.type === "GeometryCollection") return geometry.geometries.every(isEmptyGeometry);
  return geometry.coordinates.length === 0;
}

/** The CRS in force while reading one geometry and its members. */
interface GeometryContext {
  crs: GmlCrs;
  srsName: string | undefined;
  resolve: CrsResolver;
}

function readGeometry(
  element: Element,
  context: GeometryContext,
  dimension: number,
): Geometry | null {
  // A nested geometry can restate its own CRS; honor it.
  const ownSrs = element.getAttribute("srsName");
  if (ownSrs && ownSrs !== context.srsName) {
    return readGeometry(
      element,
      { ...context, crs: context.resolve(ownSrs), srsName: ownSrs },
      srsDimension(element, dimension),
    );
  }
  const { crs } = context;
  const dim = srsDimension(element, dimension);

  switch (localName(element)) {
    case "Point": {
      const position = readPositions(element, dim, crs)[0];
      return position ? { type: "Point", coordinates: position } : null;
    }
    case "LineString":
      return { type: "LineString", coordinates: readPositions(element, dim, crs) };
    case "Curve":
      return { type: "LineString", coordinates: curvePositions(element, dim, crs) };
    case "LinearRing":
      return { type: "Polygon", coordinates: [readPositions(element, dim, crs)] };
    case "Polygon":
      return { type: "Polygon", coordinates: polygonRings(element, dim, crs) };
    case "Surface": {
      const polygons = surfacePolygons(element, dim, crs);
      if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
      return { type: "MultiPolygon", coordinates: polygons };
    }
    case "Envelope":
    case "Box":
      return envelopePolygon(element, dim, crs);
    case "MultiPoint": {
      const points = memberGeometries(element, context, dim).flatMap((geometry) =>
        geometry.type === "Point" ? [geometry.coordinates] : [],
      );
      return { type: "MultiPoint", coordinates: points };
    }
    case "MultiLineString":
    case "MultiCurve": {
      const lines = memberGeometries(element, context, dim).flatMap((geometry) =>
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
      const polygons = memberGeometries(element, context, dim).flatMap((geometry) =>
        geometry.type === "Polygon"
          ? [geometry.coordinates]
          : geometry.type === "MultiPolygon"
            ? geometry.coordinates
            : [],
      );
      return { type: "MultiPolygon", coordinates: polygons };
    }
    case "MultiGeometry":
      return { type: "GeometryCollection", geometries: memberGeometries(element, context, dim) };
    default:
      return null;
  }
}

// Children of a multi-geometry: `*Member` (one geometry each) and `*Members`
// (several) wrappers, in document order.
function memberGeometries(
  element: Element,
  context: GeometryContext,
  dimension: number,
): Geometry[] {
  const geometries: Geometry[] = [];
  for (const wrapper of childElements(element)) {
    if (!/Members?$/.test(localName(wrapper))) continue;
    for (const child of childElements(wrapper)) {
      if (!isGeometryElement(child)) continue;
      const geometry = readGeometry(child, context, dimension);
      if (geometry) geometries.push(geometry);
    }
  }
  return geometries;
}

function polygonRings(element: Element, dimension: number, crs: GmlCrs): Position[][] {
  const rings: Position[][] = [];
  for (const boundary of childElements(element)) {
    const name = localName(boundary);
    if (!["exterior", "interior", "outerBoundaryIs", "innerBoundaryIs"].includes(name)) continue;
    const ring = childElements(boundary)[0];
    if (!ring) continue;
    const positions = ringPositions(ring, dimension, crs);
    if (positions.length === 0) continue;
    if (name === "exterior" || name === "outerBoundaryIs") rings.unshift(positions);
    else rings.push(positions);
  }
  return rings;
}

// A LinearRing, or a gml:Ring made of curveMember curves.
function ringPositions(ring: Element, dimension: number, crs: GmlCrs): Position[] {
  if (localName(ring) !== "Ring") return readPositions(ring, dimension, crs);
  const positions: Position[] = [];
  for (const member of childElements(ring)) {
    for (const curve of childElements(member)) {
      appendPath(
        positions,
        localName(curve) === "Curve"
          ? curvePositions(curve, dimension, crs)
          : readPositions(curve, dimension, crs),
      );
    }
  }
  return positions;
}

// gml:Curve → segments → LineStringSegment / Arc / ...: the control points in
// order. Arcs are drawn through their control points, not densified.
function curvePositions(curve: Element, dimension: number, crs: GmlCrs): Position[] {
  const positions: Position[] = [];
  const segments = childElements(curve).find((child) => localName(child) === "segments");
  for (const segment of segments ? childElements(segments) : []) {
    appendPath(positions, readPositions(segment, srsDimension(segment, dimension), crs));
  }
  return positions;
}

function surfacePolygons(surface: Element, dimension: number, crs: GmlCrs): Position[][][] {
  const patches = childElements(surface).find((child) =>
    /^(patches|polygonPatches)$/.test(localName(child)),
  );
  return (patches ? childElements(patches) : [])
    .map((patch) => polygonRings(patch, srsDimension(patch, dimension), crs))
    .filter((rings) => rings.length > 0);
}

function envelopePolygon(element: Element, dimension: number, crs: GmlCrs): Geometry | null {
  let corners: Position[];
  if (localName(element) === "Box") {
    corners = readPositions(element, dimension, crs);
  } else {
    // lowerCorner / upperCorner are GML 3 positions, in the CRS's axis order.
    const lower = childElements(element).find((child) => localName(child) === "lowerCorner");
    const upper = childElements(element).find((child) => localName(child) === "upperCorner");
    corners = [lower, upper]
      .map((corner) => parseNumbers(corner?.textContent))
      .filter((position) => position.length >= 2)
      .map((position) => fromGml3(position, crs));
  }
  if (corners.length < 2) return null;
  const [minX, minY] = corners[0];
  const [maxX, maxY] = corners[1];
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

// A GML 3 position (pos, posList, a corner) is written in the CRS's axis order.
function fromGml3(position: Position, crs: GmlCrs): Position {
  if (!crs.swapAxes) return crs.toLonLat(position);
  const [first, second, ...rest] = position;
  return crs.toLonLat([second, first, ...rest]);
}

// A GML 2 tuple (coordinates, coord) is always x, y: easting then northing,
// longitude then latitude, whatever the srsName says. MapServer's WFS 1.0.0
// output labels EPSG:2180 with a URN (north-first) yet writes east, north.
function fromGml2(position: Position, crs: GmlCrs): Position {
  return crs.toLonLat(position);
}

// The positions directly under a geometry element, in lon/lat, from whichever
// encoding it uses: posList, a run of pos / pointProperty, GML 2 coordinates,
// or coord.
function readPositions(element: Element, dimension: number, crs: GmlCrs): Position[] {
  const children = childElements(element);
  const posList = children.find((child) => localName(child) === "posList");
  if (posList) {
    return chunk(parseNumbers(posList.textContent), srsDimension(posList, dimension)).map(
      (position) => fromGml3(position, crs),
    );
  }
  const coordinates = children.find((child) => localName(child) === "coordinates");
  if (coordinates)
    return parseGml2Coordinates(coordinates).map((position) => fromGml2(position, crs));

  const positions: Position[] = [];
  for (const child of children) {
    const name = localName(child);
    if (name === "pos") {
      const values = parseNumbers(child.textContent);
      if (values.length >= 2) positions.push(fromGml3(values, crs));
    } else if (name === "coord") {
      const values = ["X", "Y", "Z"]
        .map((axis) => childElements(child).find((c) => localName(c) === axis)?.textContent)
        .filter((value): value is string => value != null)
        .map(Number);
      if (values.length >= 2) positions.push(fromGml2(values, crs));
    } else if (name === "pointProperty" || name === "pointRep") {
      const point = childElements(child).find((c) => localName(c) === "Point");
      if (point) positions.push(...readPositions(point, dimension, crs));
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

/** An EPSG code named by a GML `srsName`, and how it was named. */
export interface GmlEpsgName {
  code: number;
  /**
   * True for URN / `opengis.net/def/crs` names, whose GML 3 positions follow
   * the EPSG axis order; false for the legacy `EPSG:n` and `…/epsg.xml#n`
   * forms, which are x, y (east, north) by convention.
   */
  authorityAxisOrder: boolean;
}

/**
 * The EPSG code an `srsName` names, or null for a name in another form.
 *
 * @param srsName - The CRS name from the document or the request.
 * @returns The code and whether EPSG axis order applies.
 */
export function parseEpsgSrsName(srsName: string): GmlEpsgName | null {
  const name = srsName.trim();
  const authority =
    /^urn:(?:x-)?ogc:def:crs:EPSG:(?:[^:]*:)?(\d+)$/i.exec(name) ??
    /^https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/[^/]+\/(\d+)$/i.exec(name);
  if (authority) return { code: Number(authority[1]), authorityAxisOrder: true };
  const legacy =
    /^EPSG:(\d+)$/i.exec(name) ??
    /^https?:\/\/www\.opengis\.net\/gml\/srs\/epsg\.xml#(\d+)$/i.exec(name);
  return legacy ? { code: Number(legacy[1]), authorityAxisOrder: false } : null;
}

const LON_LAT: GmlCrs = { swapAxes: false, toLonLat: (position) => position };

/**
 * Resolve an `srsName` this module handles on its own: none (lon/lat), CRS84,
 * WGS84-like geographic codes, and Web Mercator.
 *
 * @param srsName - The CRS name from the document or the request.
 * @returns How to read positions in that CRS.
 * @throws {GmlUnsupportedCrsError} For any other CRS; a caller that can
 *   reproject resolves it and passes it back through `extraCrs`.
 */
export function resolveGmlCrs(srsName: string | undefined): GmlCrs {
  if (!srsName) return LON_LAT;
  const name = srsName.trim();
  if (/CRS:?84$/i.test(name)) return LON_LAT;
  const epsg = parseEpsgSrsName(name);
  const code = epsg ? String(epsg.code) : "";
  if (GEOGRAPHIC_EPSG_CODES.has(code)) {
    // Geographic CRSs are latitude-first in the EPSG registry.
    return { swapAxes: epsg!.authorityAxisOrder, toLonLat: (position) => position };
  }
  if (WEB_MERCATOR_EPSG_CODES.has(code)) {
    return {
      swapAxes: false,
      toLonLat: ([x, y, ...rest]) => [
        (x / EARTH_RADIUS) * (180 / Math.PI),
        (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI),
        ...rest,
      ],
    };
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
