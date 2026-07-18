import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  Polygon,
  Position,
} from "geojson";

/**
 * Result of parsing a GeoRSS feed into a single mixed-geometry layer.
 *
 * GeoRSS feeds routinely mix points, lines, and polygons in one document, so
 * every feed item that carries a geometry becomes one feature in a single
 * FeatureCollection (MapLibre renders the mixed collection as separate
 * circle/line/fill layers).
 */
export interface GeoRssLayerResult {
  /** All feed items that resolved to a valid geometry, as one collection. */
  features: FeatureCollection;
  /** Number of features produced (items with a usable geometry). */
  featureCount: number;
  /** The feed-level title, when present (used for layer naming/metadata). */
  feedTitle?: string;
}

/**
 * Parses a GeoRSS feed (RSS 2.0, Atom, or RSS 1.0/RDF) into a GeoJSON layer.
 *
 * Supports the three common GeoRSS geometry encodings:
 * - **Simple**: `georss:point`, `georss:line`, `georss:polygon`, `georss:box`
 * - **GML**: `georss:where` wrapping `gml:Point`/`LineString`/`Polygon`/`Envelope`
 * - **W3C Geo**: legacy `geo:lat` / `geo:long` (point only)
 *
 * Item metadata (title, description/summary, link, published date, author, id,
 * categories) is carried onto each feature's properties for the attribute table
 * and popups. GeoRSS coordinates are `latitude longitude` ordered; GeoJSON
 * output is `[longitude, latitude]`.
 *
 * @param text - The raw feed XML.
 * @param options - `allowEmpty` returns an empty layer instead of throwing when
 *   the feed has no geolocated items (used on auto-refresh, where a feed can
 *   transiently empty out and should not raise a recurring error).
 * @returns The parsed features plus counts and the feed title.
 * @throws If the text is not valid XML, is not a recognized feed, or (unless
 *   `allowEmpty`) contains no geolocated items. Messages are English-only (as in
 *   the GPX parser); the UI surfaces them verbatim, so an i18n caller must catch
 *   and translate.
 */
export function parseGeoRssLayer(
  text: string,
  options: { allowEmpty?: boolean } = {},
): GeoRssLayerResult {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error("The GeoRSS feed is not valid XML.");
  }

  const root = document.documentElement;
  const rootName = root?.localName.toLowerCase();
  let feedTitle: string | undefined;
  let items: Element[] = [];

  if (rootName === "feed") {
    // Atom: <feed><entry>...
    feedTitle = childText(root, "title");
    items = directChildren(root, "entry");
  } else if (rootName === "rss") {
    // RSS 2.0: <rss><channel><item>...
    const channel = directChildren(root, "channel")[0];
    feedTitle = channel ? childText(channel, "title") : undefined;
    items = channel ? directChildren(channel, "item") : [];
  } else if (rootName === "rdf") {
    // RSS 1.0 / RDF: <rdf:RDF><channel/><item>... (items are siblings).
    const channel = directChildren(root, "channel")[0];
    feedTitle = channel ? childText(channel, "title") : undefined;
    items = directChildren(root, "item");
  } else {
    throw new Error("The file does not contain an RSS, Atom, or RDF feed.");
  }

  const features: Feature<Geometry, GeoJsonProperties>[] = [];
  for (const [index, item] of items.entries()) {
    const geometry = geometryFromItem(item);
    if (!geometry) continue;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        ...itemProperties(item),
        georss_index: index + 1,
      },
    });
  }

  if (features.length === 0 && !options.allowEmpty) {
    throw new Error("No geolocated entries were found in the GeoRSS feed.");
  }

  return {
    features: { type: "FeatureCollection", features },
    featureCount: features.length,
    feedTitle,
  };
}

/**
 * Resolves a single feed item to a geometry, trying the GML, Simple, and W3C
 * Geo encodings in turn. Returns null when the item carries no usable geometry.
 */
function geometryFromItem(item: Element): Geometry | null {
  // 1. GML encoding: georss:where wrapping a GML geometry.
  const where = directChildren(item, "where")[0];
  if (where) {
    const geometry = gmlGeometry(where);
    if (geometry) return geometry;
  }

  // 2. Simple encoding: georss:point/line/polygon/box. The "point" element is
  //    also how W3C geo:Point appears (localName "Point"); distinguish them by
  //    whether it nests lat/long child elements (W3C) or holds text coords.
  const point = directChildren(item, "point")[0];
  if (point) {
    const nestedLat = childText(point, "lat");
    const nestedLong = childText(point, "long") ?? childText(point, "lon");
    if (nestedLat && nestedLong) {
      const coordinate = coordinate2d(nestedLong, nestedLat);
      if (coordinate) return { type: "Point", coordinates: coordinate };
    } else {
      const coordinates = parseLatLonList(point.textContent);
      if (coordinates[0]) return { type: "Point", coordinates: coordinates[0] };
    }
  }

  const line = directChildren(item, "line")[0];
  if (line) {
    const coordinates = parseLatLonList(line.textContent);
    if (coordinates.length >= 2) {
      return { type: "LineString", coordinates } satisfies LineString;
    }
  }

  const polygon = directChildren(item, "polygon")[0];
  if (polygon) {
    const ring = closeRing(parseLatLonList(polygon.textContent));
    if (ring.length >= 4) {
      return { type: "Polygon", coordinates: [ring] } satisfies Polygon;
    }
  }

  const box = directChildren(item, "box")[0];
  if (box) {
    const geometry = polygonFromBox(parseLatLonList(box.textContent));
    if (geometry) return geometry;
  }

  // 3. W3C Geo (point only): flat geo:lat / geo:long children (also the
  //    common geo:lon abbreviation).
  const lat = childText(item, "lat");
  const long = childText(item, "long") ?? childText(item, "lon");
  if (lat && long) {
    const coordinate = coordinate2d(long, lat);
    if (coordinate) return { type: "Point", coordinates: coordinate };
  }

  return null;
}

/** Parses the GML geometry nested inside a `georss:where` element. */
function gmlGeometry(where: Element): Geometry | null {
  const geometryElement = Array.from(where.children)[0];
  if (!geometryElement) return null;
  const name = geometryElement.localName.toLowerCase();

  if (name === "point") {
    const coordinates = parseLatLonList(gmlPosText(geometryElement));
    if (coordinates[0]) return { type: "Point", coordinates: coordinates[0] };
    return null;
  }

  if (name === "linestring") {
    const coordinates = parseLatLonList(gmlPosText(geometryElement));
    if (coordinates.length >= 2) return { type: "LineString", coordinates };
    return null;
  }

  if (name === "polygon") {
    const exterior =
      directChildren(geometryElement, "exterior")[0] ??
      directChildren(geometryElement, "outerBoundaryIs")[0];
    const linearRing = exterior
      ? directChildren(exterior, "LinearRing")[0]
      : directChildren(geometryElement, "LinearRing")[0];
    if (!linearRing) return null;
    const ring = closeRing(parseLatLonList(gmlPosText(linearRing)));
    // Interior rings (holes) are intentionally omitted; vanishingly rare in GeoRSS.
    if (ring.length >= 4) return { type: "Polygon", coordinates: [ring] };
    return null;
  }

  if (name === "envelope") {
    const lower = parseLatLonList(childText(geometryElement, "lowerCorner"));
    const upper = parseLatLonList(childText(geometryElement, "upperCorner"));
    return polygonFromBox([...lower, ...upper]);
  }

  return null;
}

/**
 * Collects the coordinate text from a GML geometry element, accepting either a
 * single `gml:pos`/`gml:posList` or several `gml:pos` children (or, for legacy
 * GML 2, `gml:coordinates`).
 */
function gmlPosText(element: Element): string {
  const posList = directChildren(element, "posList")[0];
  if (posList?.textContent) return posList.textContent;
  const coordinates = directChildren(element, "coordinates")[0];
  if (coordinates?.textContent) {
    // GML 2 <coordinates> is lon,lat order; swap each pair so the lat-first parseLatLonList holds.
    return coordinates.textContent
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [lon, lat] = pair.split(",");
        return lat && lon ? `${lat} ${lon}` : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  const positions = directChildren(element, "pos");
  if (positions.length > 0) {
    return positions.map((pos) => pos.textContent ?? "").join(" ");
  }
  return "";
}

function polygonFromBox(corners: Position[]): Polygon | null {
  if (corners.length < 2) return null;
  const [first, second] = corners;
  const minLon = Math.min(first[0], second[0]);
  const minLat = Math.min(first[1], second[1]);
  const maxLon = Math.max(first[0], second[0]);
  const maxLat = Math.max(first[1], second[1]);
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

/**
 * Parses a whitespace-separated `lat lon lat lon ...` string (GeoRSS/GML order)
 * into `[lon, lat]` GeoJSON positions, dropping any out-of-range pair.
 */
function parseLatLonList(text: string | null | undefined): Position[] {
  if (!text) return [];
  const numbers = text
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isFinite(value));
  const positions: Position[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const coordinate = makeCoordinate(numbers[i + 1], numbers[i]);
    if (coordinate) positions.push(coordinate);
  }
  return positions;
}

function coordinate2d(longitude: string, latitude: string): Position | null {
  return makeCoordinate(Number(longitude), Number(latitude));
}

function makeCoordinate(longitude: number, latitude: number): Position | null {
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
  return [longitude, latitude];
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

const GEORSS_LINK_RELS_TO_SKIP = new Set(["self", "edit", "replies"]);

/**
 * Builds the GeoJSON properties for a feed item, carrying the common RSS/Atom
 * metadata (title, description, link, published date, author, id, categories).
 */
function itemProperties(item: Element): GeoJsonProperties {
  const properties: GeoJsonProperties = {};

  const title = childText(item, "title");
  if (title) properties.title = title;

  // RSS: <description>; Atom: <summary> or <content>. Stored as raw text (RSS
  // descriptions often hold CDATA-wrapped HTML); GeoLibre renders all property
  // values as text nodes (identify popup setDOMContent + textContent, attribute
  // table React children), so the markup is never parsed and needs no sanitizing.
  const description =
    childText(item, "description") ?? childText(item, "summary") ?? childText(item, "content");
  if (description) properties.description = description;

  // Keep only http(s) links; a feed could carry a javascript:/data: href that
  // would become an XSS vector if the UI ever makes the link clickable.
  const link = itemLink(item);
  if (link && /^https?:/i.test(link)) properties.link = link;

  // RSS: <pubDate>; Atom: <updated>/<published>; RSS 1.0: <dc:date>.
  const published =
    childText(item, "pubDate") ??
    childText(item, "published") ??
    childText(item, "updated") ??
    childText(item, "date");
  if (published) properties.published = published;

  const author = itemAuthor(item);
  if (author) properties.author = author;

  const id = childText(item, "guid") ?? childText(item, "id");
  if (id) properties.id = id;

  const categories = itemCategories(item);
  if (categories) properties.category = categories;

  return properties;
}

/**
 * Resolves an item's link. Atom uses `<link href>` (preferring the alternate
 * relation); RSS uses the element's text content.
 */
function itemLink(item: Element): string | undefined {
  const links = directChildren(item, "link");
  if (links.length === 0) return undefined;

  const withHref = links.filter((link) => link.getAttribute("href"));
  if (withHref.length > 0) {
    const alternate = withHref.find(
      (link) => (link.getAttribute("rel") ?? "alternate") === "alternate",
    );
    const usable = withHref.find(
      (link) => !GEORSS_LINK_RELS_TO_SKIP.has(link.getAttribute("rel") ?? ""),
    );
    const chosen = alternate ?? usable ?? withHref[0];
    return chosen.getAttribute("href") ?? undefined;
  }

  return links[0].textContent?.trim() || undefined;
}

/** Resolves an item's author from RSS text or an Atom `<author><name>`. */
function itemAuthor(item: Element): string | undefined {
  const author = directChildren(item, "author")[0];
  if (!author) {
    // RSS 1.0 / Dublin Core creator.
    return childText(item, "creator");
  }
  const name = childText(author, "name");
  if (name) return name;
  return author.textContent?.trim() || undefined;
}

/**
 * Joins an item's categories into a comma-separated string. RSS categories hold
 * text; Atom categories carry the value in the `term` attribute.
 */
function itemCategories(item: Element): string | undefined {
  const categories = directChildren(item, "category")
    .map((category) => category.getAttribute("term") ?? category.textContent?.trim() ?? "")
    .filter(Boolean);
  return categories.length > 0 ? categories.join(", ") : undefined;
}

/** Returns the direct child elements with the given (case-insensitive) name. */
function directChildren(parent: Element, localName: string): Element[] {
  const wanted = localName.toLowerCase();
  return Array.from(parent.children).filter((child) => child.localName.toLowerCase() === wanted);
}

/** Returns the trimmed text of the first matching direct child, if any. */
function childText(parent: Element, localName: string): string | undefined {
  const child = directChildren(parent, localName)[0];
  const value = child?.textContent?.trim();
  return value || undefined;
}
