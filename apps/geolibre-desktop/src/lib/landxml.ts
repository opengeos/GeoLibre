import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  Point,
  Polygon,
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
  /** True when every parsed XY coordinate fits WGS84 longitude/latitude bounds. */
  coordinatesLookGeographic: boolean;
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
 * reordered while retaining its Z value. TIN faces become triangular polygons,
 * horizontal alignment lines and curves become LineStrings, and CgPoints become
 * points. Spiral segments currently retain their defining Start, PI, and End
 * vertices. Vertical profile PVIs are preserved on alignment properties.
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
  const surfaces = descendants(root, "Surface");
  for (const [surfaceIndex, surface] of surfaces.entries()) {
    const layer = parseSurface(surface, surfaceIndex, coordinates);
    if (layer) layers.push(layer);
  }

  const alignmentElements = descendants(root, "Alignment");
  const alignmentFeatures: Feature<LineString, GeoJsonProperties>[] = [];
  let profileCount = 0;
  for (const [alignmentIndex, alignment] of alignmentElements.entries()) {
    const parsed = parseAlignment(alignment, alignmentIndex, coordinates);
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

  const pointFeatures = parseCgPoints(root, coordinates);
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

function parseSurface(
  surface: Element,
  surfaceIndex: number,
  allCoordinates: Position[],
): LandXmlLayer | null {
  const name = surface.getAttribute("name")?.trim() || `Surface ${surfaceIndex + 1}`;
  const definition = firstDescendant(surface, "Definition") ?? surface;
  const pointById = new Map<string, Position>();

  for (const point of descendants(definition, "P")) {
    const id = point.getAttribute("id")?.trim();
    const coordinate = landXmlPosition(point.textContent);
    if (!id || !coordinate) continue;
    pointById.set(id, coordinate);
    allCoordinates.push(coordinate);
  }

  const features: Feature<Polygon, GeoJsonProperties>[] = [];
  for (const [faceIndex, face] of descendants(definition, "F").entries()) {
    const ids = tokens(face.textContent).slice(0, 3);
    if (ids.length !== 3) continue;
    const triangle = ids.map((id) => pointById.get(id));
    if (triangle.some((position) => !position)) continue;
    const coordinates = triangle as Position[];
    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[...coordinates, coordinates[0]]],
      },
      properties: {
        landxml_kind: "surface_face",
        surface_name: name,
        surface_index: surfaceIndex + 1,
        face_index: faceIndex + 1,
        point_ids: ids.join(","),
      },
    });
  }

  if (features.length === 0) return null;
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
): { feature: Feature<LineString, GeoJsonProperties> | null; profileCount: number } {
  const profiles = parseProfiles(alignment);
  const coordGeom = firstDescendant(alignment, "CoordGeom");
  if (!coordGeom) return { feature: null, profileCount: profiles.length };

  const coordinates: Position[] = [];
  for (const segment of Array.from(coordGeom.children)) {
    appendCoordinates(coordinates, alignmentSegmentPositions(segment));
  }
  if (coordinates.length < 2) {
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
    return pi ? [start, pi, end] : [start, end];
  }
  if (kind === "irregularline") {
    const points = descendants(segment, "P")
      .map((point) => landXmlPosition(point.textContent))
      .filter((position): position is Position => position !== null);
    return points.length >= 2 ? points : [start, end];
  }
  return [start, end];
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
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
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
): Feature<Point, GeoJsonProperties>[] {
  const features: Feature<Point, GeoJsonProperties>[] = [];
  for (const [index, point] of descendants(root, "CgPoint").entries()) {
    const coordinate = landXmlPosition(point.textContent);
    if (!coordinate) continue;
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
  return descendants(parent, localName)[0];
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

function featureCollection<G extends Point | LineString | Polygon>(
  features: Feature<G, GeoJsonProperties>[],
): FeatureCollection<G, GeoJsonProperties> {
  return { type: "FeatureCollection", features };
}
