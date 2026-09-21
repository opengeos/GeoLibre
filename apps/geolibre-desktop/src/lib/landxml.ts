import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  MultiPolygon,
  Point,
  Position,
} from "geojson";

export type LandXmlLayerKind = "alignment" | "points" | "surface";

export interface LandXmlLayer {
  /** Suggested suffix for the layer list. */
  name: string;
  /** LandXML object family represented by this layer. */
  kind: LandXmlLayerKind;
  /** Parsed geometry in the LandXML document's source coordinate system. */
  features: FeatureCollection;
}

export interface LandXmlParseResult {
  /** Map-ready object groups. Each TIN surface is kept as its own layer. */
  layers: LandXmlLayer[];
  /** EPSG authority code discovered on the CoordinateSystem element, if any. */
  detectedCrs?: string;
  /** Human-readable coordinate-system metadata from the document. */
  coordinateSystem?: string;
  /** Linear unit declared by the LandXML Units element, if present. */
  linearUnit?: string;
  /** True when every parsed XY coordinate fits WGS84 longitude/latitude bounds. */
  coordinatesLookGeographic: boolean;
  /** Diagnostics for malformed source objects that were skipped during parsing. */
  warnings: string[];
  surfaceCount: number;
  alignmentCount: number;
  pointCount: number;
  profileCount: number;
}

interface VerticalProfile {
  name: string;
  pvis: Array<[number, number]>;
}

/**
 * Parse a LandXML document into GeoJSON object groups.
 *
 * LandXML coordinates are northing, easting, and optional elevation. GeoJSON
 * uses easting (X), northing (Y), and optional elevation, so every position is
 * reordered while retaining its Z value. Each TIN surface becomes one
 * MultiPolygon whose parts are its triangular faces, horizontal alignment lines
 * and curves become LineStrings, and CgPoints become points. Spiral segments
 * use their tangent intersection as a quadratic control
 * point to produce a smooth approximation. Vertical profile PVIs are preserved
 * on alignment properties.
 *
 * @param text Raw LandXML text.
 * @returns Parsed layers, coordinate-system hints, and object counts.
 * @throws If the input is invalid XML, is not LandXML, or has no supported geometry.
 */
export function parseLandXml(text: string): LandXmlParseResult {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error("The LandXML file is not valid XML.");
  }

  const root = document.documentElement;
  if (!root || root.localName.toLowerCase() !== "landxml") {
    throw new Error("The file does not contain a LandXML document.");
  }

  const coordinates: Position[] = [];
  const layers: LandXmlLayer[] = [];
  const warnings: string[] = [];
  const linearUnit = readLinearUnit(root);
  if (linearUnit && !/^(?:metre|meter)$/i.test(linearUnit)) {
    warnings.push(
      `LandXML declares linear unit "${linearUnit}". Verify that the selected CRS uses the same coordinate unit.`,
    );
  }
  const surfaces = descendants(root, "Surface");
  for (const [surfaceIndex, surface] of surfaces.entries()) {
    const layer = parseSurface(surface, surfaceIndex, coordinates, warnings);
    if (layer) layers.push(layer);
  }

  const alignmentElements = descendants(root, "Alignment");
  const alignmentFeatures: Feature<LineString, GeoJsonProperties>[] = [];
  let profileCount = 0;
  for (const [alignmentIndex, alignment] of alignmentElements.entries()) {
    const parsed = parseAlignment(alignment, alignmentIndex, coordinates, warnings);
    profileCount += parsed.profileCount;
    if (parsed.feature) alignmentFeatures.push(parsed.feature);
  }
  if (alignmentFeatures.length > 0) {
    layers.push({
      name: "Alignments",
      kind: "alignment",
      features: featureCollection(alignmentFeatures),
    });
  }

  const pointFeatures = parseCgPoints(root, coordinates, warnings);
  if (pointFeatures.length > 0) {
    layers.push({
      name: "Survey Points",
      kind: "points",
      features: featureCollection(pointFeatures),
    });
  }

  if (layers.length === 0) {
    throw new Error("No supported LandXML surfaces, alignments, or CgPoints were found.");
  }

  const coordinateInfo = readCoordinateSystem(root);
  return {
    layers,
    detectedCrs: coordinateInfo.detectedCrs,
    coordinateSystem: coordinateInfo.description,
    linearUnit,
    warnings,
    coordinatesLookGeographic:
      coordinates.length > 0 &&
      coordinates.every(
        ([x, y]) =>
          Number.isFinite(x) && Number.isFinite(y) && x >= -180 && x <= 180 && y >= -90 && y <= 90,
      ),
    surfaceCount: layers.filter((layer) => layer.kind === "surface").length,
    alignmentCount: alignmentFeatures.length,
    pointCount: pointFeatures.length,
    profileCount,
  };
}

/** A GeoJSON coordinate array at any nesting depth. */
type NestedPositions = Position | NestedPositions[];

function isPosition(node: NestedPositions): node is Position {
  return typeof node[0] === "number";
}

/** Key a position by its full tuple so points that differ only in Z stay distinct. */
function positionKey(position: Position): string {
  return position.join(",");
}

function visitPositions(node: NestedPositions, visit: (position: Position) => void): void {
  if (isPosition(node)) {
    visit(node);
    return;
  }
  for (const child of node) visitPositions(child, visit);
}

function rebuildPositions(
  node: NestedPositions,
  replace: (position: Position) => Position,
): NestedPositions {
  if (isPosition(node)) return replace(node);
  return node.map((child) => rebuildPositions(child, replace));
}

function eachGeometry(geometry: Geometry, visit: (geometry: Geometry) => void): void {
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) eachGeometry(child, visit);
    return;
  }
  visit(geometry);
}

/**
 * Reproject a parsed LandXML collection by transforming each distinct vertex
 * once rather than every occurrence of it.
 *
 * A TIN stores its faces as indices into a shared point table, so the same
 * vertex reappears in roughly six triangles. Handing the assembled geometry to
 * the reprojection engine therefore transforms every corner separately — for
 * the 27,310-face sample in discussion #2489 that is 81,930 coordinates instead
 * of the 13,708 the surface actually has, and the engine round-trips the whole
 * collection through DuckDB's GDAL reader to do it. Deduplicating first keeps
 * the transform proportional to the surface's real vertex count.
 *
 * @param collection The parsed layer geometry, in the document's source CRS.
 * @param reprojectPositions Transforms a position list to WGS84, preserving
 *   order and length. Injected so this stays independent of the map engine.
 * @returns A collection with the same shape and properties, in WGS84.
 */
export async function reprojectLandXmlCollection(
  collection: FeatureCollection,
  reprojectPositions: (positions: Position[]) => Promise<Position[]>,
): Promise<FeatureCollection> {
  const distinct: Position[] = [];
  const indexByKey = new Map<string, number>();
  for (const feature of collection.features) {
    if (!feature.geometry) continue;
    eachGeometry(feature.geometry, (geometry) => {
      if (geometry.type === "GeometryCollection") return;
      visitPositions(geometry.coordinates, (position) => {
        const key = positionKey(position);
        if (indexByKey.has(key)) return;
        indexByKey.set(key, distinct.length);
        distinct.push(position);
      });
    });
  }
  if (distinct.length === 0) return collection;

  const reprojected = await reprojectByDimension(distinct, reprojectPositions);
  const replace = (position: Position): Position => {
    const index = indexByKey.get(positionKey(position));
    return index === undefined ? position : reprojected[index];
  };

  return {
    ...collection,
    features: collection.features.map((feature) => {
      if (!feature.geometry) return feature;
      return { ...feature, geometry: replaceGeometryPositions(feature.geometry, replace) };
    }),
  };
}

/**
 * Reproject positions in one batch per coordinate dimension.
 *
 * LandXML elevations are optional, so a single layer can hold both `[x, y]` and
 * `[x, y, z]` positions — a CgPoint with no elevation beside one that has it, or
 * a curve sampled between two endpoints that carry no Z. Engines that transform
 * a batch as one multi-part geometry require a consistent dimension across the
 * parts and pad the short ones, which would turn "no elevation" into a real
 * elevation of zero. Grouping first keeps each batch homogeneous, so a 2D
 * position stays 2D.
 */
async function reprojectByDimension(
  positions: Position[],
  reprojectPositions: (positions: Position[]) => Promise<Position[]>,
): Promise<Position[]> {
  const indicesByDimension = new Map<number, number[]>();
  for (const [index, position] of positions.entries()) {
    const existing = indicesByDimension.get(position.length);
    if (existing) existing.push(index);
    else indicesByDimension.set(position.length, [index]);
  }

  const reprojected: Position[] = new Array(positions.length);
  for (const indices of indicesByDimension.values()) {
    const batch = await reprojectPositions(indices.map((index) => positions[index]));
    if (batch.length !== indices.length) {
      throw new Error("Reprojection returned a different number of coordinates than it was given.");
    }
    for (const [batchIndex, sourceIndex] of indices.entries()) {
      reprojected[sourceIndex] = batch[batchIndex];
    }
  }
  return reprojected;
}

function replaceGeometryPositions(
  geometry: Geometry,
  replace: (position: Position) => Position,
): Geometry {
  if (geometry.type === "GeometryCollection") {
    return {
      ...geometry,
      geometries: geometry.geometries.map((child) => replaceGeometryPositions(child, replace)),
    };
  }
  return {
    ...geometry,
    coordinates: rebuildPositions(geometry.coordinates, replace),
  } as Geometry;
}

function parseSurface(
  surface: Element,
  surfaceIndex: number,
  allCoordinates: Position[],
  warnings: string[],
): LandXmlLayer | null {
  const name = surface.getAttribute("name")?.trim() || `Surface ${surfaceIndex + 1}`;
  const definition = firstDescendant(surface, "Definition") ?? surface;
  const pointById = new Map<string, Position>();
  let skippedPointCount = 0;

  for (const point of descendants(definition, "P")) {
    const id = point.getAttribute("id")?.trim();
    const coordinate = landXmlPosition(point.textContent);
    if (!id || !coordinate) {
      skippedPointCount += 1;
      continue;
    }
    pointById.set(id, coordinate);
    allCoordinates.push(coordinate);
  }

  // Every triangle becomes one part of a single MultiPolygon rather than its
  // own Feature. A real TIN runs to tens of thousands of faces, and a feature
  // per face made the import cost scale with face count: each one carried a
  // duplicate property bag, and the WGS84 reprojection pays a per-row cost
  // because it round-trips the collection through DuckDB's GDAL reader.
  // The per-face identity was not useful on the map either — identifying a
  // surface reported "face 17312" instead of the surface itself.
  const triangles: Position[][][] = [];
  let skippedFaceCount = 0;
  for (const face of descendants(definition, "F")) {
    const ids = tokens(face.textContent).slice(0, 3);
    if (ids.length !== 3) {
      skippedFaceCount += 1;
      continue;
    }
    // Civil 3D uses a negative point reference to mark the following TIN edge
    // as hidden. The magnitude still identifies the surface point.
    const triangle = ids.map((id) => pointById.get(id.replace(/^-/, "")));
    if (triangle.some((position) => !position)) {
      skippedFaceCount += 1;
      continue;
    }
    const coordinates = triangle as Position[];
    triangles.push([[...coordinates, coordinates[0]]]);
  }

  if (skippedPointCount > 0 || skippedFaceCount > 0) {
    warnings.push(
      `${name}: skipped ${skippedPointCount} invalid surface point(s) and ${skippedFaceCount} invalid TIN face(s).`,
    );
  }
  if (triangles.length === 0 && skippedFaceCount === 0) {
    warnings.push(`${name}: no usable TIN faces were found.`);
  }

  if (triangles.length === 0) return null;
  const properties: NonNullable<GeoJsonProperties> = {
    landxml_kind: "surface",
    surface_name: name,
    surface_index: surfaceIndex + 1,
    face_count: triangles.length,
    point_count: pointById.size,
  };
  const description = surface.getAttribute("desc")?.trim();
  if (description) properties.description = description;
  const features: Feature<MultiPolygon, GeoJsonProperties>[] = [
    {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: triangles },
      properties,
    },
  ];
  return {
    name,
    kind: "surface",
    features: featureCollection(features),
  };
}

function parseAlignment(
  alignment: Element,
  alignmentIndex: number,
  allCoordinates: Position[],
  warnings: string[],
): { feature: Feature<LineString, GeoJsonProperties> | null; profileCount: number } {
  const profiles = parseProfiles(alignment);
  const coordGeom = firstDescendant(alignment, "CoordGeom");
  if (!coordGeom) {
    warnings.push(`Alignment ${alignmentIndex + 1}: no horizontal geometry was found.`);
    return { feature: null, profileCount: profiles.length };
  }

  const coordinates: Position[] = [];
  for (const segment of Array.from(coordGeom.children)) {
    appendCoordinates(coordinates, alignmentSegmentPositions(segment));
  }
  if (coordinates.length < 2) {
    warnings.push(`Alignment ${alignmentIndex + 1}: no usable horizontal geometry was found.`);
    return { feature: null, profileCount: profiles.length };
  }
  allCoordinates.push(...coordinates);

  const name = alignment.getAttribute("name")?.trim() || `Alignment ${alignmentIndex + 1}`;
  const properties: NonNullable<GeoJsonProperties> = {
    landxml_kind: "alignment",
    alignment_name: name,
    alignment_index: alignmentIndex + 1,
    segment_count: Array.from(coordGeom.children).length,
    point_count: coordinates.length,
    profile_count: profiles.length,
  };
  copyNumericAttribute(alignment, properties, "length");
  copyNumericAttribute(alignment, properties, "staStart", "start_station");
  const description = alignment.getAttribute("desc")?.trim();
  if (description) properties.description = description;
  if (profiles.length > 0) {
    properties.profile_names = profiles.map((profile) => profile.name).join(", ");
    properties.profile_pvis = JSON.stringify(profiles.map((profile) => profile.pvis));
    properties.profile_pvi_count = profiles.reduce(
      (count, profile) => count + profile.pvis.length,
      0,
    );
  }

  return {
    feature: {
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties,
    },
    profileCount: profiles.length,
  };
}

function alignmentSegmentPositions(segment: Element): Position[] {
  const kind = segment.localName.toLowerCase();
  const start = childPosition(segment, "Start");
  const end = childPosition(segment, "End");
  if (!start || !end) return [];

  if (kind === "curve") {
    const center = childPosition(segment, "Center");
    return center ? sampleCurve(start, center, end, segment.getAttribute("rot")) : [start, end];
  }
  if (kind === "spiral") {
    const pi = childPosition(segment, "PI");
    return pi ? sampleSpiral(start, pi, end) : [start, end];
  }
  if (kind === "irregularline") {
    const points = descendants(segment, "P")
      .map((point) => landXmlPosition(point.textContent))
      .filter((position): position is Position => position !== null);
    return points.length >= 2 ? points : [start, end];
  }
  return [start, end];
}

function sampleSpiral(start: Position, pi: Position, end: Position): Position[] {
  const steps = 16;
  const positions: Position[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps;
    const inverse = 1 - fraction;
    const z = interpolatedZ(start, end, fraction);
    positions.push([
      inverse * inverse * start[0] + 2 * inverse * fraction * pi[0] + fraction * fraction * end[0],
      inverse * inverse * start[1] + 2 * inverse * fraction * pi[1] + fraction * fraction * end[1],
      ...(z === undefined ? [] : [z]),
    ]);
  }
  positions[0] = start;
  positions[positions.length - 1] = end;
  return positions;
}

function sampleCurve(
  start: Position,
  center: Position,
  end: Position,
  rotation: string | null,
): Position[] {
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = endAngle - startAngle;
  const normalizedRotation = rotation?.trim().toLowerCase();
  if (normalizedRotation === "cw") {
    while (sweep >= 0) sweep -= Math.PI * 2;
  } else if (normalizedRotation === "ccw") {
    while (sweep <= 0) sweep += Math.PI * 2;
  } else {
    if (Math.abs(sweep) < 1e-12) {
      // With a usable center, coincident endpoints describe a complete circle.
      // Default to counterclockwise when malformed input omits the required
      // rotation direction instead of collapsing the arc to repeated points.
      sweep = Math.PI * 2;
    } else {
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      while (sweep < -Math.PI) sweep += Math.PI * 2;
    }
  }

  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  if (!Number.isFinite(radius) || radius === 0) return [start, end];
  const steps = Math.max(2, Math.min(72, Math.ceil(Math.abs(sweep) / (Math.PI / 36))));
  const positions: Position[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps;
    const angle = startAngle + sweep * fraction;
    const z = interpolatedZ(start, end, fraction);
    positions.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
      ...(z === undefined ? [] : [z]),
    ]);
  }
  // Preserve the source endpoints exactly instead of retaining trigonometric drift.
  positions[0] = start;
  positions[positions.length - 1] = end;
  return positions;
}

function parseProfiles(alignment: Element): VerticalProfile[] {
  return descendants(alignment, "ProfAlign").map((profile, index) => {
    const pvis = descendants(profile, "PVI")
      .map((pvi) => numberPair(pvi.textContent))
      .filter((pair): pair is [number, number] => pair !== null);
    return {
      name: profile.getAttribute("name")?.trim() || `Profile ${index + 1}`,
      pvis,
    };
  });
}

function parseCgPoints(
  root: Element,
  allCoordinates: Position[],
  warnings: string[],
): Feature<Point, GeoJsonProperties>[] {
  const features: Feature<Point, GeoJsonProperties>[] = [];
  let skippedPointCount = 0;
  for (const [index, point] of descendants(root, "CgPoint").entries()) {
    const coordinate = landXmlPosition(point.textContent);
    if (!coordinate) {
      skippedPointCount += 1;
      continue;
    }
    allCoordinates.push(coordinate);
    const properties: NonNullable<GeoJsonProperties> = {
      landxml_kind: "survey_point",
      point_index: index + 1,
    };
    for (const attribute of ["name", "desc", "code", "state"] as const) {
      const value = point.getAttribute(attribute)?.trim();
      if (value) properties[attribute === "desc" ? "description" : attribute] = value;
    }
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coordinate },
      properties,
    });
  }
  if (skippedPointCount > 0) {
    warnings.push(`Skipped ${skippedPointCount} invalid survey point(s).`);
  }
  return features;
}

function readCoordinateSystem(root: Element): { detectedCrs?: string; description?: string } {
  const element = firstDescendant(root, "CoordinateSystem");
  if (!element) return {};
  const values = Array.from(element.attributes)
    .map((attribute) => attribute.value.trim())
    .filter(Boolean);
  const attributes = Array.from(element.attributes);
  const canonicalEpsg = attributes.find(
    (attribute) => /epsg/i.test(attribute.name) && /^\d{3,6}$/.test(attribute.value.trim()),
  );
  const textMatch = attributes
    .map((attribute) => attribute.value.trim().match(/EPSG(?::+|[ _-])?(\d{3,6})/i))
    .find((match) => match !== null);
  const detectedCrs = canonicalEpsg
    ? `EPSG:${canonicalEpsg.value.trim()}`
    : textMatch
      ? `EPSG:${textMatch[1]}`
      : undefined;
  return {
    detectedCrs,
    description: values.join(" | ") || undefined,
  };
}

function readLinearUnit(root: Element): string | undefined {
  const units = firstDescendant(root, "Units");
  if (!units) return undefined;
  for (const child of Array.from(units.children)) {
    const linearUnit = child.getAttribute("linearUnit")?.trim();
    if (linearUnit) return linearUnit;
  }
  return units.getAttribute("linearUnit")?.trim() || undefined;
}

function landXmlPosition(text: string | null | undefined): Position | null {
  const values = numericTokens(text);
  if (values.length < 2 || values.length > 3) return null;
  const [northing, easting, elevation] = values;
  return [easting, northing, ...(elevation === undefined ? [] : [elevation])];
}

function childPosition(parent: Element, name: string): Position | null {
  const child = Array.from(parent.children).find(
    (candidate) => candidate.localName.toLowerCase() === name.toLowerCase(),
  );
  return landXmlPosition(child?.textContent);
}

function interpolatedZ(start: Position, end: Position, fraction: number): number | undefined {
  const startZ = start[2];
  const endZ = end[2];
  if (!Number.isFinite(startZ) && !Number.isFinite(endZ)) return undefined;
  if (!Number.isFinite(startZ)) return endZ;
  if (!Number.isFinite(endZ)) return startZ;
  return startZ + (endZ - startZ) * fraction;
}

function appendCoordinates(target: Position[], incoming: Position[]): void {
  for (const coordinate of incoming) {
    const previous = target[target.length - 1];
    if (previous && samePosition(previous, coordinate)) continue;
    target.push(coordinate);
  }
}

function samePosition(first: Position, second: Position): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function numericTokens(text: string | null | undefined): number[] {
  const values = tokens(text).map(Number);
  return values.every((value) => Number.isFinite(value)) ? values : [];
}

function numberPair(text: string | null | undefined): [number, number] | null {
  const values = numericTokens(text);
  return values.length >= 2 ? [values[0], values[1]] : null;
}

function tokens(text: string | null | undefined): string[] {
  return (text ?? "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
}

function descendants(parent: Element, localName: string): Element[] {
  const expected = localName.toLowerCase();
  const matches: Element[] = [];
  const visit = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (child.localName.toLowerCase() === expected) matches.push(child);
      visit(child);
    }
  };
  visit(parent);
  return matches;
}

function firstDescendant(parent: Element, localName: string): Element | undefined {
  const expected = localName.toLowerCase();
  const visit = (element: Element): Element | undefined => {
    for (const child of Array.from(element.children)) {
      if (child.localName.toLowerCase() === expected) return child;
      const nested = visit(child);
      if (nested) return nested;
    }
    return undefined;
  };
  return visit(parent);
}

function copyNumericAttribute(
  element: Element,
  properties: NonNullable<GeoJsonProperties>,
  attribute: string,
  property = attribute,
): void {
  const raw = element.getAttribute(attribute);
  if (raw === null || raw.trim() === "") return;
  const value = Number(raw);
  if (Number.isFinite(value)) properties[property] = value;
}

function featureCollection<G extends Point | LineString | MultiPolygon>(
  features: Feature<G, GeoJsonProperties>[],
): FeatureCollection<G, GeoJsonProperties> {
  return { type: "FeatureCollection", features };
}
