import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  Position,
} from "geojson";

/**
 * A minimal KML reader that, unlike the DuckDB/GDAL path, preserves the
 * embedded symbology so styled KML/KMZ renders the way it does in Google Earth.
 * Geometry, names, ExtendedData attributes, and the colors/widths declared in
 * `<Style>`/`<StyleMap>` (resolved through inline styles and `<styleUrl>`
 * references) are emitted as GeoJSON features whose properties include
 * [simplestyle-spec](https://github.com/mapbox/simplestyle-spec) keys
 * (`fill`, `fill-opacity`, `stroke`, `stroke-width`, `stroke-opacity`,
 * `marker-color`). The store's `addGeoJsonLayer` detects those keys and enables
 * per-feature styling automatically.
 *
 * Advanced constructs this reader does not handle (e.g. `gx:Track`) yield no
 * features; callers fall back to the DuckDB loader, which renders geometry
 * without the embedded styling.
 */

interface KmlStyle {
  stroke?: string;
  "stroke-opacity"?: number;
  "stroke-width"?: number;
  fill?: string;
  "fill-opacity"?: number;
  "marker-color"?: string;
}

/**
 * Parse a KML document into a styled GeoJSON FeatureCollection.
 *
 * @param text - The raw KML XML text.
 * @returns A FeatureCollection with one feature per Placemark, carrying
 *   simplestyle-spec properties resolved from the document's styles.
 * @throws If the text is not valid XML, is not a KML document, or contains no
 *   readable Placemark geometry.
 */
export function parseKmlText(text: string): FeatureCollection {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error("The KML file is not valid XML.");
  }

  const root = document.documentElement;
  if (!root || root.localName.toLowerCase() !== "kml") {
    throw new Error("The file does not contain a KML document.");
  }

  const styles = collectStyles(root);
  const styleMaps = collectStyleMaps(root);
  const features: Feature[] = [];

  for (const placemark of descendants(root, "Placemark")) {
    const geometry = geometryFromPlacemark(placemark);
    if (!geometry) continue;
    features.push({
      type: "Feature",
      geometry,
      properties: placemarkProperties(placemark, styles, styleMaps),
    });
  }

  if (features.length === 0) {
    throw new Error("No readable KML placemarks were found.");
  }

  return { type: "FeatureCollection", features };
}

function placemarkProperties(
  placemark: Element,
  styles: Map<string, KmlStyle>,
  styleMaps: Map<string, string>,
): GeoJsonProperties {
  const properties: GeoJsonProperties = {};

  const name = childText(placemark, "name");
  if (name !== undefined) properties.name = name;
  const description = childText(placemark, "description");
  if (description !== undefined) properties.description = description;

  for (const [key, value] of Object.entries(extendedData(placemark))) {
    if (!(key in properties)) properties[key] = value;
  }

  const style = resolvePlacemarkStyle(placemark, styles, styleMaps);
  return { ...properties, ...style };
}

function resolvePlacemarkStyle(
  placemark: Element,
  styles: Map<string, KmlStyle>,
  styleMaps: Map<string, string>,
): KmlStyle {
  const inline = directChild(placemark, "Style");
  if (inline) return styleFromElement(inline);

  const styleUrl = childText(placemark, "styleUrl");
  const id = styleUrl ? stripHash(styleUrl) : undefined;
  if (!id) return {};

  // A styleUrl may point at a StyleMap, whose "normal" pair points at the real
  // Style; resolve one hop through the map before looking up the style.
  const resolvedId = styleMaps.get(id) ?? id;
  return styles.get(resolvedId) ?? {};
}

function collectStyles(root: Element): Map<string, KmlStyle> {
  const styles = new Map<string, KmlStyle>();
  for (const element of descendants(root, "Style")) {
    const id = element.getAttribute("id");
    if (id) styles.set(id, styleFromElement(element));
  }
  return styles;
}

// StyleMap id -> the Style/StyleMap id referenced by its "normal" pair.
function collectStyleMaps(root: Element): Map<string, string> {
  const styleMaps = new Map<string, string>();
  for (const element of descendants(root, "StyleMap")) {
    const id = element.getAttribute("id");
    if (!id) continue;
    for (const pair of directChildren(element, "Pair")) {
      if (childText(pair, "key")?.toLowerCase() !== "normal") continue;
      const target = childText(pair, "styleUrl");
      if (target) styleMaps.set(id, stripHash(target));
    }
  }
  return styleMaps;
}

function styleFromElement(element: Element): KmlStyle {
  const style: KmlStyle = {};

  const lineStyle = directChild(element, "LineStyle");
  if (lineStyle) {
    const color = parseKmlColor(childText(lineStyle, "color"));
    if (color) {
      style.stroke = color.color;
      style["stroke-opacity"] = color.opacity;
    }
    const width = Number(childText(lineStyle, "width"));
    if (Number.isFinite(width)) style["stroke-width"] = width;
  }

  const polyStyle = directChild(element, "PolyStyle");
  if (polyStyle) {
    const color = parseKmlColor(childText(polyStyle, "color"));
    const filled = childText(polyStyle, "fill") !== "0";
    if (color) {
      style.fill = color.color;
      style["fill-opacity"] = filled ? color.opacity : 0;
    } else if (!filled) {
      style["fill-opacity"] = 0;
    }
  }

  const iconStyle = directChild(element, "IconStyle");
  if (iconStyle) {
    const color = parseKmlColor(childText(iconStyle, "color"));
    if (color) style["marker-color"] = color.color;
  }

  return style;
}

/**
 * Convert a KML color (`aabbggrr` hex: alpha, blue, green, red) into a
 * simplestyle `#rrggbb` color plus an opacity in [0, 1]. Returns null when the
 * value is missing or malformed.
 */
function parseKmlColor(
  value: string | undefined,
): { color: string; opacity: number } | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(hex)) return null;
  const alpha = Number.parseInt(hex.slice(0, 2), 16);
  const blue = hex.slice(2, 4);
  const green = hex.slice(4, 6);
  const red = hex.slice(6, 8);
  return {
    color: `#${red}${green}${blue}`,
    opacity: Math.round((alpha / 255) * 100) / 100,
  };
}

function geometryFromPlacemark(placemark: Element): Geometry | null {
  const geometries = directGeometries(placemark);
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];
  return { type: "GeometryCollection", geometries };
}

// Collect the geometry elements directly under a Placemark or MultiGeometry,
// recursing through nested MultiGeometry containers.
function directGeometries(parent: Element): Geometry[] {
  const geometries: Geometry[] = [];
  for (const child of Array.from(parent.children)) {
    const name = child.localName.toLowerCase();
    if (name === "multigeometry") {
      geometries.push(...directGeometries(child));
    } else {
      const geometry = geometryFromElement(child);
      if (geometry) geometries.push(geometry);
    }
  }
  return geometries;
}

function geometryFromElement(element: Element): Geometry | null {
  switch (element.localName.toLowerCase()) {
    case "point": {
      const coordinates = coordinateList(element);
      return coordinates.length > 0
        ? { type: "Point", coordinates: coordinates[0] }
        : null;
    }
    case "linestring":
    case "linearring": {
      const coordinates = coordinateList(element);
      return coordinates.length >= 2
        ? { type: "LineString", coordinates }
        : null;
    }
    case "polygon": {
      const rings = polygonRings(element);
      return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null;
    }
    default:
      return null;
  }
}

function polygonRings(polygon: Element): Position[][] {
  const rings: Position[][] = [];
  const outer = directChild(polygon, "outerBoundaryIs");
  if (outer) {
    const ring = boundaryRing(outer);
    if (ring) rings.push(ring);
  }
  for (const inner of directChildren(polygon, "innerBoundaryIs")) {
    const ring = boundaryRing(inner);
    if (ring) rings.push(ring);
  }
  return rings;
}

function boundaryRing(boundary: Element): Position[] | null {
  const linearRing = directChild(boundary, "LinearRing");
  if (!linearRing) return null;
  const coordinates = coordinateList(linearRing);
  if (coordinates.length < 3) return null;
  return closeRing(coordinates);
}

// GeoJSON requires the first and last position of a ring to be identical; KML
// rings usually are, but close them defensively.
function closeRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function coordinateList(geometry: Element): Position[] {
  const text = childText(geometry, "coordinates");
  if (!text) return [];
  return text
    .split(/\s+/)
    .map(parseCoordinate)
    .filter((coordinate): coordinate is Position => coordinate !== null);
}

function parseCoordinate(tuple: string): Position | null {
  if (!tuple.trim()) return null;
  const parts = tuple.split(",");
  if (parts.length < 2) return null;
  const longitude = Number(parts[0]);
  const latitude = Number(parts[1]);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null;
  }
  const elevation = Number(parts[2]);
  if (parts.length >= 3 && Number.isFinite(elevation)) {
    return [longitude, latitude, elevation];
  }
  return [longitude, latitude];
}

function extendedData(placemark: Element): Record<string, string> {
  const data: Record<string, string> = {};
  const container = directChild(placemark, "ExtendedData");
  if (!container) return data;

  for (const element of descendants(container, "Data")) {
    const name = element.getAttribute("name");
    const value = childText(element, "value");
    if (name && value !== undefined) data[name] = value;
  }
  for (const element of descendants(container, "SimpleData")) {
    const name = element.getAttribute("name");
    const value = element.textContent?.trim();
    if (name && value) data[name] = value;
  }
  return data;
}

function descendants(parent: Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  return Array.from(parent.getElementsByTagName("*")).filter(
    (element) => element.localName.toLowerCase() === target,
  );
}

function directChildren(parent: Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  return Array.from(parent.children).filter(
    (child) => child.localName.toLowerCase() === target,
  );
}

function directChild(parent: Element, localName: string): Element | undefined {
  return directChildren(parent, localName)[0];
}

function childText(parent: Element, localName: string): string | undefined {
  const child = directChild(parent, localName);
  const value = child?.textContent?.trim();
  return value || undefined;
}

function stripHash(value: string): string {
  return value.trim().replace(/^#/, "");
}
