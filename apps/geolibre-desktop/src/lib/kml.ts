import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Position } from "geojson";

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
  // Non-standard simplestyle extension: KML IconStyle carries an alpha channel
  // that the spec has no key for, so it is round-tripped here and wired into
  // circle-opacity by the map package.
  "marker-opacity"?: number;
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
  const styleMaps = collectStyleMaps(root, styles);
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

/**
 * A `<GroundOverlay>` extracted from a KML document: a georeferenced raster
 * image draped over the map. The image itself is referenced by {@link href}
 * (an archive-relative path in a KMZ, or an absolute URL); the caller resolves
 * it to a loadable URL. Corners are pre-computed in MapLibre image-source order
 * so a GroundOverlay maps directly onto an `image` layer.
 */
export interface KmlGroundOverlay {
  /** The overlay's `<name>`, when present. */
  name?: string;
  /** The `<Icon><href>` value: an archive-relative path or an absolute URL. */
  href: string;
  /**
   * The four overlay corners as `[lng, lat]` in MapLibre image-source order:
   * top-left, top-right, bottom-right, bottom-left. Any `<LatLonBox><rotation>`
   * (counter-clockwise degrees about the box center) is baked in.
   */
  coordinates: [number, number][];
  /** Overlay extent as `[west, south, east, north]` in WGS84 degrees. */
  bounds: [number, number, number, number];
  /** Overlay opacity in [0, 1], from the `<color>` alpha channel (default 1). */
  opacity: number;
  /** The `<drawOrder>` (default 0); higher values draw on top. */
  drawOrder: number;
  /**
   * The overlay's KML time primitive as epoch-millisecond bounds, when it
   * carries a `<TimeSpan>` or `<TimeStamp>`. `begin`/`end` are `null` when
   * open-ended (or, for a `<TimeStamp>`, `end` is `null` and `begin` is the
   * instant). Absent when the overlay has no time. Callers sequence a set of
   * time-tagged overlays into an animation.
   */
  time?: KmlTimeBounds;
}

/** Epoch-millisecond bounds of a KML `<TimeSpan>`/`<TimeStamp>`. */
export interface KmlTimeBounds {
  begin: number | null;
  end: number | null;
}

/**
 * Parse the `<GroundOverlay>` image overlays out of a KML document. Unlike
 * {@link parseKmlText} this never throws: a document with no overlays (or one
 * that is not valid KML) yields an empty array, so callers can request both
 * vector placemarks and overlays from the same file independently.
 *
 * Only `<LatLonBox>` overlays are handled; the non-standard `gx:LatLonQuad`
 * form is skipped.
 *
 * @param text - The raw KML XML text.
 * @returns The document's ground overlays, in document order.
 */
export function parseKmlGroundOverlays(text: string): KmlGroundOverlay[] {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) return [];
  const root = document.documentElement;
  if (!root || root.localName.toLowerCase() !== "kml") return [];

  const overlays: KmlGroundOverlay[] = [];
  for (const element of descendants(root, "GroundOverlay")) {
    const overlay = groundOverlayFromElement(element);
    if (overlay) overlays.push(overlay);
  }
  return overlays;
}

function groundOverlayFromElement(element: Element): KmlGroundOverlay | null {
  const icon = directChild(element, "Icon");
  const href = icon ? childText(icon, "href") : undefined;
  if (!href) return null;

  const box = directChild(element, "LatLonBox");
  if (!box) return null;
  const north = Number(childText(box, "north"));
  const south = Number(childText(box, "south"));
  const east = Number(childText(box, "east"));
  const west = Number(childText(box, "west"));
  if (![north, south, east, west].every((value) => Number.isFinite(value))) {
    return null;
  }
  // A zero-area box has nothing to render.
  if (north === south || east === west) return null;
  // Reject a box outside WGS84 range (a malformed overlay); MapLibre's image
  // source would otherwise silently drop such corners, leaving an invisible
  // layer with no feedback.
  if (north > 90 || south < -90 || north < south || Math.abs(east) > 180 || Math.abs(west) > 180) {
    return null;
  }

  const rotation = Number(childText(box, "rotation"));
  const coordinates = latLonBoxCorners(
    north,
    south,
    east,
    west,
    Number.isFinite(rotation) ? rotation : 0,
  );

  const color = parseKmlColor(childText(element, "color"));
  const drawOrder = Number(childText(element, "drawOrder"));
  const name = childText(element, "name");
  const time = parseKmlTime(element);

  return {
    ...(name !== undefined ? { name } : {}),
    href,
    coordinates,
    bounds: [west, south, east, north],
    opacity: color ? color.opacity : 1,
    drawOrder: Number.isFinite(drawOrder) ? drawOrder : 0,
    ...(time ? { time } : {}),
  };
}

/**
 * Read a KML `<TimeSpan>` or `<TimeStamp>` from an element into epoch-ms bounds.
 * A `<TimeSpan>` yields `{begin, end}` (either side `null` when open); a
 * `<TimeStamp>` yields `{begin: when, end: null}`. Returns null when the element
 * has no (parseable) time primitive. Handles the KML date forms `YYYY`,
 * `YYYY-MM`, `YYYY-MM-DD`, and full `dateTime` via `Date.parse`.
 */
function parseKmlTime(element: Element): KmlTimeBounds | null {
  // KML time can be inherited: a `<TimeSpan>`/`<TimeStamp>` on an enclosing
  // `<Folder>`/`<Document>` applies to descendant features that lack their own,
  // so walk up until one is found (the overlay's own primitive wins).
  for (let node: Element | null = element; node; node = node.parentElement) {
    const span = directChild(node, "TimeSpan");
    if (span) {
      const begin = parseKmlDate(childText(span, "begin"));
      const end = parseKmlDate(childText(span, "end"));
      if (begin === null && end === null) return null;
      return { begin, end };
    }
    const stamp = directChild(node, "TimeStamp");
    if (stamp) {
      const when = parseKmlDate(childText(stamp, "when"));
      if (when === null) return null;
      return { begin: when, end: null };
    }
  }
  return null;
}

/**
 * Parse a KML date/dateTime string to epoch milliseconds, or null when missing
 * or unparseable. A bare year (`YYYY`) is normalized to `YYYY-01-01` so engines
 * that would otherwise read it as a millisecond count do not misinterpret it,
 * and a `00` month or day component (Google Earth Pro exports month granularity
 * as `YYYY-MM-00`, which is not valid ISO) is clamped to `01`.
 */
export function parseKmlDate(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let normalized = trimmed;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(trimmed);
  const ym = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (/^\d{4}$/.test(trimmed)) {
    normalized = `${trimmed}-01-01`;
  } else if (ym) {
    normalized = `${ym[1]}-${ym[2] === "00" ? "01" : ym[2]}-01`;
  } else if (ymd) {
    const month = ymd[2] === "00" ? "01" : ymd[2];
    const day = ymd[3] === "00" ? "01" : ymd[3];
    normalized = `${ymd[1]}-${month}-${day}${ymd[4]}`;
  }
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Compute the four `[lng, lat]` corners of a `<LatLonBox>` in MapLibre
 * image-source order (top-left, top-right, bottom-right, bottom-left). A
 * non-zero `rotation` (KML rotates the overlay counter-clockwise about the box
 * center) is applied in a local tangent plane: longitude offsets are scaled by
 * cos(centerLat) before the rotation and unscaled after, so the on-screen angle
 * matches Google Earth instead of skewing away from the equator.
 */
export function latLonBoxCorners(
  north: number,
  south: number,
  east: number,
  west: number,
  rotation: number,
): [number, number][] {
  const corners: [number, number][] = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
  if (!rotation) return corners;

  const centerLng = (east + west) / 2;
  const centerLat = (north + south) / 2;
  const theta = (rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const latScale = Math.cos((centerLat * Math.PI) / 180) || 1;
  return corners.map(([lng, lat]): [number, number] => {
    const dx = (lng - centerLng) * latScale;
    const dy = lat - centerLat;
    return [centerLng + (dx * cos - dy * sin) / latScale, centerLat + (dx * sin + dy * cos)];
  });
}

/**
 * A `<Model>` 3D model extracted from a KML document: a mesh (typically a
 * COLLADA `.dae`) placed at a geographic location. The mesh is referenced by
 * {@link href} (an archive-relative path in a KMZ, or an absolute URL); the
 * caller resolves and renders it.
 */
export interface KmlModel {
  /** The enclosing Placemark's `<name>`, when present. */
  name?: string;
  /** The `<Link><href>` (or `<Icon><href>`): an archive-relative path or URL. */
  href: string;
  /** `<Location>` longitude in WGS84 degrees. */
  longitude: number;
  /** `<Location>` latitude in WGS84 degrees. */
  latitude: number;
  /** `<Location>` altitude in meters (default 0). */
  altitude: number;
  /** `<Orientation>` heading (rotation about the up axis), degrees (default 0). */
  heading: number;
  /** `<Orientation>` tilt (rotation about the east axis), degrees (default 0). */
  tilt: number;
  /** `<Orientation>` roll (rotation about the north axis), degrees (default 0). */
  roll: number;
  /** `<Scale>` factors along the model's x/y/z axes (default 1 each). */
  scale: { x: number; y: number; z: number };
}

/**
 * Parse the `<Model>` 3D models out of a KML document. Like
 * {@link parseKmlGroundOverlays} this never throws: a document with no models
 * (or invalid KML) yields an empty array.
 *
 * @param text - The raw KML XML text.
 * @returns The document's models, in document order.
 */
export function parseKmlModels(text: string): KmlModel[] {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) return [];
  const root = document.documentElement;
  if (!root || root.localName.toLowerCase() !== "kml") return [];

  const models: KmlModel[] = [];
  for (const element of descendants(root, "Model")) {
    const model = modelFromElement(element);
    if (model) models.push(model);
  }
  return models;
}

function modelFromElement(element: Element): KmlModel | null {
  // KML 2.2 uses <Link><href>; some exports use <Icon><href>.
  const link = directChild(element, "Link") ?? directChild(element, "Icon");
  const href = link ? childText(link, "href") : undefined;
  if (!href) return null;

  const location = directChild(element, "Location");
  const longitude = Number(location && childText(location, "longitude"));
  const latitude = Number(location && childText(location, "latitude"));
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return null;
  }
  // KML's default altitudeMode is clampToGround, which ignores <altitude> and
  // drapes the model on the terrain; only `absolute` and `relativeToGround`
  // define a vertical offset. There's no client-side DEM to clamp against, so
  // treat clamped modes as ground level (0) — otherwise a stale/leftover
  // <altitude> (common in SketchUp/Google Earth exports) leaves the model
  // floating in the air.
  const altitudeMode = childText(element, "altitudeMode")?.toLowerCase();
  const honorsAltitude = altitudeMode === "absolute" || altitudeMode === "relativetoground";
  const altitude = honorsAltitude ? numberOr(location && childText(location, "altitude"), 0) : 0;

  const orientation = directChild(element, "Orientation");
  const heading = numberOr(orientation && childText(orientation, "heading"), 0);
  const tilt = numberOr(orientation && childText(orientation, "tilt"), 0);
  const roll = numberOr(orientation && childText(orientation, "roll"), 0);

  const scaleEl = directChild(element, "Scale");
  const scale = {
    x: numberOr(scaleEl && childText(scaleEl, "x"), 1),
    y: numberOr(scaleEl && childText(scaleEl, "y"), 1),
    z: numberOr(scaleEl && childText(scaleEl, "z"), 1),
  };

  const name = enclosingPlacemarkName(element);

  return {
    ...(name !== undefined ? { name } : {}),
    href,
    longitude,
    latitude,
    altitude,
    heading,
    tilt,
    roll,
    scale,
  };
}

// A <Model> is normally wrapped in a <Placemark> whose <name> labels it.
function enclosingPlacemarkName(element: Element): string | undefined {
  let node: Element | null = element.parentElement;
  while (node) {
    if (node.localName.toLowerCase() === "placemark") {
      return childText(node, "name");
    }
    node = node.parentElement;
  }
  return undefined;
}

function numberOr(value: string | undefined | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

// StyleMap id -> the Style/StyleMap id referenced by its "normal" pair. A
// `<Pair>` may carry an inline `<Style>` instead of a `<styleUrl>` (KML 2.2
// §12.2); that inline style is registered in `styles` under a synthetic id so
// the lookup path in `resolvePlacemarkStyle` stays uniform.
function collectStyleMaps(root: Element, styles: Map<string, KmlStyle>): Map<string, string> {
  const styleMaps = new Map<string, string>();
  for (const element of descendants(root, "StyleMap")) {
    const id = element.getAttribute("id");
    if (!id) continue;
    for (const pair of directChildren(element, "Pair")) {
      if (childText(pair, "key")?.toLowerCase() !== "normal") continue;
      const inlineStyle = directChild(pair, "Style");
      if (inlineStyle) {
        // The leading space cannot appear in an author-defined id resolved
        // through `stripHash`, so this synthetic key cannot collide with one.
        const syntheticId = ` stylemap-normal:${id}`;
        styles.set(syntheticId, styleFromElement(inlineStyle));
        styleMaps.set(id, syntheticId);
        continue;
      }
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
    if (color) {
      style["marker-color"] = color.color;
      style["marker-opacity"] = color.opacity;
    }
  }

  return style;
}

/**
 * Convert a KML color (`aabbggrr` hex: alpha, blue, green, red) into a
 * simplestyle `#rrggbb` color plus an opacity in [0, 1]. Returns null when the
 * value is missing or malformed.
 */
function parseKmlColor(value: string | undefined): { color: string; opacity: number } | null {
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
      return coordinates.length > 0 ? { type: "Point", coordinates: coordinates[0] } : null;
    }
    case "linestring": {
      const coordinates = coordinateList(element);
      return coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
    }
    // A standalone LinearRing (outside a Polygon boundary) is semantically a
    // closed loop, so emit it as a single-ring Polygon and close it defensively.
    case "linearring": {
      const coordinates = coordinateList(element);
      return coordinates.length >= 3
        ? { type: "Polygon", coordinates: [closeRing(coordinates)] }
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

  // <Data> is a direct child of <ExtendedData>; <SimpleData> is nested one
  // level deeper inside <SchemaData>, so it still needs a descendant scan.
  for (const element of directChildren(container, "Data")) {
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
  return Array.from(parent.children).filter((child) => child.localName.toLowerCase() === target);
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
