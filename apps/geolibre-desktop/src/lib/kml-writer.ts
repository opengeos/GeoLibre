import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  Position,
} from "geojson";

const KML_NAMESPACE = "http://www.opengis.net/kml/2.2";

function xmlSafeText(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "\uFFFD")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indentXml(xml: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return xml
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}

function positionText(position: Position): string {
  if (position.length < 2 || position.slice(0, 3).some((value) => !Number.isFinite(value))) {
    throw new Error("KML export requires finite longitude and latitude coordinates.");
  }
  return position.slice(0, 3).join(",");
}

function coordinatesText(positions: Position[]): string {
  return positions.map(positionText).join(" ");
}

function closedRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    first.length === last.length &&
    first.every((coordinate, index) => coordinate === last[index])
  ) {
    return ring;
  }
  return [...ring, first];
}

function polygonKml(coordinates: Position[][]): string {
  const [outer, ...inner] = coordinates;
  const boundaries: string[] = [];
  if (outer) {
    boundaries.push(
      "<outerBoundaryIs>",
      "  <LinearRing>",
      `    <coordinates>${coordinatesText(closedRing(outer))}</coordinates>`,
      "  </LinearRing>",
      "</outerBoundaryIs>",
    );
  }
  for (const ring of inner) {
    boundaries.push(
      "<innerBoundaryIs>",
      "  <LinearRing>",
      `    <coordinates>${coordinatesText(closedRing(ring))}</coordinates>`,
      "  </LinearRing>",
      "</innerBoundaryIs>",
    );
  }
  if (boundaries.length === 0) return "<Polygon />";
  return `<Polygon>\n${indentXml(boundaries.join("\n"), 2)}\n</Polygon>`;
}

function multiGeometryKml(geometries: Geometry[]): string {
  if (geometries.length === 0) return "<MultiGeometry />";
  return `<MultiGeometry>\n${geometries
    .map((geometry) => indentXml(geometryKml(geometry), 2))
    .join("\n")}\n</MultiGeometry>`;
}

function geometryKml(geometry: Geometry): string {
  switch (geometry.type) {
    case "Point":
      return `<Point><coordinates>${positionText(geometry.coordinates)}</coordinates></Point>`;
    case "MultiPoint":
      return multiGeometryKml(
        geometry.coordinates.map((coordinates) => ({ type: "Point", coordinates })),
      );
    case "LineString":
      return `<LineString><coordinates>${coordinatesText(geometry.coordinates)}</coordinates></LineString>`;
    case "MultiLineString":
      return multiGeometryKml(
        geometry.coordinates.map((coordinates) => ({ type: "LineString", coordinates })),
      );
    case "Polygon":
      return polygonKml(geometry.coordinates);
    case "MultiPolygon":
      return multiGeometryKml(
        geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates })),
      );
    case "GeometryCollection":
      return multiGeometryKml(geometry.geometries);
  }
}

function propertyText(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function propertyElement(properties: GeoJsonProperties, key: string): string | null {
  const value = properties?.[key];
  return value == null || typeof value === "object"
    ? null
    : `<${key}>${xmlSafeText(value)}</${key}>`;
}

function extendedDataKml(feature: Feature): string | null {
  const entries = Object.entries(feature.properties ?? {});
  if (feature.id != null && !Object.hasOwn(feature.properties ?? {}, "feature_id")) {
    entries.unshift(["feature_id", feature.id]);
  }
  if (entries.length === 0) return null;
  const data = entries.map(
    ([key, value]) =>
      `<Data name="${xmlSafeText(key)}"><value>${xmlSafeText(propertyText(value))}</value></Data>`,
  );
  return `<ExtendedData>\n${data.map((entry) => indentXml(entry, 2)).join("\n")}\n</ExtendedData>`;
}

function opacityByte(value: unknown): string {
  const opacity = typeof value === "number" ? value : Number(value ?? 1);
  const normalized = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
  return Math.round(normalized * 255)
    .toString(16)
    .padStart(2, "0");
}

function kmlColor(color: unknown, opacity: unknown): string | null {
  if (typeof color !== "string") return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : match[1];
  const red = hex.slice(0, 2);
  const green = hex.slice(2, 4);
  const blue = hex.slice(4, 6);
  return `${opacityByte(opacity)}${blue}${green}${red}`.toLowerCase();
}

function styleKml(properties: GeoJsonProperties): string | null {
  if (!properties) return null;
  const sections: string[] = [];

  const markerColor = kmlColor(properties["marker-color"], properties["marker-opacity"]);
  if (markerColor) {
    sections.push(`<IconStyle><color>${markerColor}</color></IconStyle>`);
  }

  const strokeColor = kmlColor(properties.stroke, properties["stroke-opacity"]);
  const strokeWidth = Number(properties["stroke-width"]);
  if (strokeColor || Number.isFinite(strokeWidth)) {
    const values = [
      strokeColor ? `<color>${strokeColor}</color>` : null,
      Number.isFinite(strokeWidth) ? `<width>${strokeWidth}</width>` : null,
    ].filter((value): value is string => value !== null);
    sections.push(`<LineStyle>${values.join("")}</LineStyle>`);
  }

  const fillColor = kmlColor(properties.fill, properties["fill-opacity"]);
  if (fillColor) {
    sections.push(`<PolyStyle><color>${fillColor}</color></PolyStyle>`);
  }

  if (sections.length === 0) return null;
  return `<Style>${sections.join("")}</Style>`;
}

function featureKml(feature: Feature): string {
  const properties = feature.properties ?? {};
  const contents = [
    propertyElement(properties, "name"),
    propertyElement(properties, "description"),
    styleKml(properties),
    extendedDataKml(feature),
    feature.geometry ? geometryKml(feature.geometry) : null,
  ].filter((value): value is string => value !== null);

  if (contents.length === 0) return "<Placemark />";
  return `<Placemark>\n${contents.map((value) => indentXml(value, 2)).join("\n")}\n</Placemark>`;
}

/**
 * Convert a GeoJSON FeatureCollection to a KML 2.2 document.
 *
 * All feature properties are retained in ExtendedData. Common `name`,
 * `description`, and simplestyle properties are also promoted to their native
 * KML elements for display in Google Earth and other KML clients.
 */
export function writeKml(geojson: FeatureCollection, documentName: string): string {
  const placemarks = geojson.features.map((feature) => indentXml(featureKml(feature), 4));
  const documentContents = [
    `    <name>${xmlSafeText(documentName)}</name>`,
    ...placemarks,
  ].join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<kml xmlns="${KML_NAMESPACE}">`,
    "  <Document>",
    documentContents,
    "  </Document>",
    "</kml>",
  ].join("\n");
}
