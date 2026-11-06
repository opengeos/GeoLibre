/**
 * IndoorGML import (issue #3341).
 *
 * IndoorGML (OGC 14-005, versions 1.0.x) describes a building as cells: rooms,
 * corridors, stairs and doors (`CellSpace` and the navigation module's
 * `GeneralSpace`, `TransitionSpace`, `ConnectionSpace`, `AnchorSpace`), each
 * usually a `gml:Solid`, plus a navigation graph of `State` nodes (one per
 * cell, through `duality`) joined by `Transition` edges.
 *
 * This module reads a document into three collections in the document's own
 * coordinates:
 *
 * - **cells**: each cell's footprint (its floor faces, or the outline of its
 *   vertices when it has none) with `base_z` and `top_z`, its lowest and
 *   highest elevation measured from the lowest point of the building, so the
 *   cells extrude to their real heights;
 * - **states** and **transitions**: the navigation graph, keeping its Z.
 *
 * Every feature carries a `level`, for the floor picker: the storey the
 * document names (`storey="2"` in a cell's description, as InEditor writes
 * it, which may be a range such as `1-2` for a staircase), or else a floor
 * number worked out from the cells' base elevations, with the floor nearest
 * the document's zero as floor 0.
 *
 * IndoorGML files often carry no CRS at all (many are in a local building
 * frame), so the caller supplies one, or places local coordinates with
 * {@link placeLocalCoordinates}.
 *
 * Pure apart from `DOMParser`, so it is unit tested directly.
 */
import { parseLevelValue } from "@geolibre/core";
import type { Feature, FeatureCollection, Position } from "geojson";

/** Cell element names: the core `CellSpace` and the navigation module's spaces. */
const CELL_TYPES = new Set([
  "CellSpace",
  "NavigableSpace",
  "GeneralSpace",
  "TransitionSpace",
  "ConnectionSpace",
  "AnchorSpace",
  "NonNavigableSpace",
]);

/** Two base elevations this close (metres) are on the same floor. */
const FLOOR_GAP = 1.2;
/** A face whose Z varies by less than this (metres) is horizontal. */
const FLAT_TOLERANCE = 0.05;
/** Height given to a cell drawn in 2D only (metres). */
const DEFAULT_CELL_HEIGHT = 3;

/** What {@link parseIndoorGml} found. */
export interface IndoorGmlParseResult {
  /** Cell footprints with `base_z`/`top_z`, in the document's coordinates. */
  cells: FeatureCollection;
  /** Navigation graph nodes (3D points). */
  states: FeatureCollection;
  /** Navigation graph edges (3D lines). */
  transitions: FeatureCollection;
  /** `EPSG:<code>` from a `srsName`, when the document names one. */
  detectedCrs?: string;
  /** True when every X/Y fits WGS84 longitude/latitude bounds. */
  coordinatesLookGeographic: boolean;
  /** Where the floors came from: the document's storeys, the cells' elevations, or nowhere. */
  levelSource: "storey" | "elevation" | "none";
  /** The floors found, as the `level` values written on the features. */
  levels: string[];
  /** Problems with single cells that were skipped. */
  warnings: string[];
}

/** An element's name without its namespace prefix. */
function localName(element: Element): string {
  const name = element.localName || element.nodeName;
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/** The element children of `element`. */
function childElements(element: Element): Element[] {
  const out: Element[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) out.push(node as Element);
  }
  return out;
}

/** The first child element with this local name. */
function child(element: Element, name: string): Element | undefined {
  return childElements(element).find((item) => localName(item) === name);
}

/** Every descendant element with one of these local names, in document order. */
function descendants(element: Element, names: ReadonlySet<string>): Element[] {
  const out: Element[] = [];
  const stack = childElements(element).reverse();
  while (stack.length) {
    const next = stack.pop()!;
    if (names.has(localName(next))) out.push(next);
    const children = childElements(next);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return out;
}

/** An attribute by local name, whatever its prefix (`gml:id`, `xlink:href`). */
function attribute(element: Element, name: string): string | null {
  for (const attr of Array.from(element.attributes)) {
    const local = attr.localName || attr.name;
    if (local === name || local.endsWith(`:${name}`)) return attr.value;
  }
  return null;
}

/** The trimmed text of a child element, or null. */
function childText(element: Element, name: string): string | null {
  const text = child(element, name)?.textContent?.trim();
  return text ? text : null;
}

/** Numbers in a whitespace-separated list. */
function numbers(text: string | null | undefined): number[] {
  if (!text) return [];
  return text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
}

/** The `srsDimension` that applies to an element (its own, or an ancestor's). */
function srsDimension(element: Element): number | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = Number(attribute(node, "srsDimension"));
    if (value === 2 || value === 3) return value;
  }
  return null;
}

/**
 * How the document being parsed writes its coordinates. Set at the start of
 * {@link parseIndoorGml}, which is synchronous, so one parse never sees
 * another's.
 */
const context = {
  /** The dimension of a `posList` with no `srsDimension` in scope. */
  dimension: 3,
  /** Whether positions are latitude first (an EPSG URN or URL for a geographic CRS). */
  swapAxes: false,
  /** Polygons by `gml:id`, for surfaces a solid references with `xlink:href`. */
  polygons: new Map<string, Element>(),
};

/** Geographic CRSs whose EPSG axis order is latitude, longitude. */
const LATITUDE_FIRST = new Set(["EPSG:4326", "EPSG:4258", "EPSG:4269", "EPSG:4979", "EPSG:4937"]);

/** A position as GeoJSON wants it: X (or longitude) first. */
function position(values: number[]): Position {
  const out = values.slice(0, 3);
  if (context.swapAxes) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

/** The smallest and largest of some numbers, without spreading them into an argument list. */
function extremes(values: Iterable<number>): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return [low, high];
}

/** 2 inside a cell's `Geometry2D`, 3 inside a `Geometry3D` or `Solid`, else unknown. */
function geometryDimension(element: Element): 2 | 3 | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const name = localName(node);
    if (name === "Geometry2D") return 2;
    if (name === "Geometry3D" || name === "Solid") return 3;
  }
  return null;
}

/** The positions of a `LinearRing`, `LineString` or `Point` (`pos`, `posList` or `coordinates`). */
function readPositions(element: Element): Position[] {
  const out: Position[] = [];
  for (const item of childElements(element)) {
    const name = localName(item);
    if (name === "pos") {
      const values = numbers(item.textContent);
      if (values.length >= 2 && values.every(Number.isFinite)) out.push(position(values));
    } else if (name === "posList") {
      // The ordinate count cannot tell 2D from 3D (six numbers are three 2D
      // or two 3D positions), so the dimension comes from srsDimension or the
      // document (see parseIndoorGml).
      const values = numbers(item.textContent);
      const dimension = srsDimension(item) ?? geometryDimension(item) ?? context.dimension;
      for (let index = 0; index + dimension <= values.length; index += dimension) {
        const tuple = values.slice(index, index + dimension);
        if (tuple.every(Number.isFinite)) out.push(position(tuple));
      }
    } else if (name === "coordinates") {
      for (const tuple of (item.textContent ?? "").trim().split(/\s+/)) {
        const values = tuple.split(",").map(Number);
        if (values.length >= 2 && values.every(Number.isFinite)) out.push(position(values));
      }
    }
  }
  return out;
}

/** A `gml:Polygon`'s rings: the exterior first, then the holes. */
function readPolygon(polygon: Element): Position[][] {
  const rings: Position[][] = [];
  for (const part of childElements(polygon)) {
    const name = localName(part);
    if (name !== "exterior" && name !== "interior") continue;
    const ring = child(part, "LinearRing");
    const positions = ring ? readPositions(ring) : [];
    if (positions.length < 3) continue;
    if (name === "exterior") rings.unshift(positions);
    else rings.push(positions);
  }
  return rings;
}

const POLYGON = new Set(["Polygon"]);
const SURFACE_MEMBER = new Set(["surfaceMember", "patches"]);

/** The Z of a position, or 0 for a 2D one. */
function zOf(position: Position): number {
  return position.length > 2 && Number.isFinite(position[2]) ? position[2] : 0;
}

/** Twice the signed area of a ring in X/Y (positive when counter-clockwise). */
function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** A closed 2D ring, wound counter-clockwise for an exterior and clockwise for a hole. */
function flatRing(ring: Position[], exterior: boolean): Position[] {
  const flat = ring.map((position) => [position[0], position[1]]);
  const first = flat[0];
  const last = flat[flat.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) flat.push([first[0], first[1]]);
  const ccw = signedArea(flat) > 0;
  return ccw === exterior ? flat : flat.reverse();
}

/** The convex hull of some points in X/Y, as a closed counter-clockwise ring. */
function convexHull(points: Position[]): Position[] {
  const sorted = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, [p[0], p[1]]])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (sorted.length < 3) return [];
  const cross = (o: Position, a: Position, b: Position) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Position[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0)
      lower.pop();
    lower.push(point);
  }
  const upper: Position[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0)
      upper.pop();
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return hull.length >= 3 ? [...hull, hull[0]] : [];
}

/** A cell read from the document, before floors are assigned. */
interface RawCell {
  id: string;
  name: string | null;
  kind: string;
  className: string | null;
  function: string | null;
  usage: string | null;
  storey: string | null;
  footprint: Position[][][];
  minZ: number;
  maxZ: number;
  has3d: boolean;
}

/** The storey a cell names, from IndoorGML 2's `level` or InEditor's `storey="…"` description. */
function readStorey(cell: Element): string | null {
  const level = childText(cell, "level") ?? childText(cell, "storey");
  if (level) return level;
  const description = childText(cell, "description");
  const match = description ? /storey\s*=\s*"([^"]*)"/i.exec(description) : null;
  return match && match[1].trim() ? match[1].trim() : null;
}

/**
 * A cell's footprint and elevation range: its floor faces (the horizontal
 * faces at its lowest Z), or the outline of all its vertices when it has none.
 */
function readCellGeometry(
  cell: Element,
): Pick<RawCell, "footprint" | "minZ" | "maxZ" | "has3d"> | null {
  const geometry = child(cell, "cellSpaceGeometry");
  if (!geometry) return null;
  // Surfaces are inline, or referenced by xlink:href from a surfaceMember.
  const referenced = descendants(geometry, SURFACE_MEMBER)
    .filter((member) => !childElements(member).length)
    .map((member) => context.polygons.get(hrefId(member) ?? ""))
    .filter((polygon): polygon is Element => polygon !== undefined);
  const polygons = [...descendants(geometry, POLYGON), ...referenced]
    .map(readPolygon)
    .filter((rings) => rings.length > 0);
  if (polygons.length === 0) return null;
  const all = polygons.flat(2);
  const [minZ, maxZ] = extremes(all.map(zOf));
  const has3d = child(geometry, "Geometry3D") !== undefined || maxZ - minZ > FLAT_TOLERANCE;
  if (!has3d) {
    return {
      footprint: polygons.map((rings) => rings.map((ring, index) => flatRing(ring, index === 0))),
      minZ,
      maxZ: minZ,
      has3d,
    };
  }
  const floors = polygons.filter((rings) => {
    const [low, high] = extremes(rings.flat().map(zOf));
    return high - low <= FLAT_TOLERANCE && low - minZ <= FLAT_TOLERANCE;
  });
  // No floor face (a sloped stair, an open shell): the outline of all its
  // vertices stands in. A concave room drawn that way fills its corners in.
  const footprint = floors.length
    ? floors.map((rings) => rings.map((ring, index) => flatRing(ring, index === 0)))
    : [[convexHull(all)]].filter((rings) => rings[0].length > 0);
  return footprint.length ? { footprint, minZ, maxZ, has3d } : null;
}

/** An `EPSG:<code>` from a GML `srsName`, in any of its usual spellings. */
export function epsgFromSrsName(srsName: string | null | undefined): string | undefined {
  if (!srsName) return undefined;
  const match =
    /EPSG(?::|::|\/\d*\/?|\/0\/)(\d+)\s*$/i.exec(srsName.trim()) ??
    /crs\/EPSG\/[^/]*\/(\d+)/i.exec(srsName);
  return match ? `EPSG:${match[1]}` : undefined;
}

/**
 * Floor numbers from base elevations: bases within {@link FLOOR_GAP} of the
 * lowest base of a floor share it, and the floor nearest `zero` is floor 0.
 *
 * @param bases - Each cell's base elevation.
 * @param zero - The elevation counted as the ground floor.
 * @returns The floor number for each base, in input order.
 */
export function floorsFromElevations(bases: readonly number[], zero: number): number[] {
  const sorted = [...new Set(bases)].sort((a, b) => a - b);
  const starts: number[] = [];
  for (const base of sorted) {
    if (!starts.length || base - starts[starts.length - 1] > FLOOR_GAP) starts.push(base);
  }
  const floorOf = (base: number) => {
    let index = 0;
    while (index + 1 < starts.length && base >= starts[index + 1]) index += 1;
    return index;
  };
  let ground = 0;
  for (let index = 1; index < starts.length; index += 1) {
    if (Math.abs(starts[index] - zero) < Math.abs(starts[ground] - zero)) ground = index;
  }
  return bases.map((base) => floorOf(base) - ground);
}

/**
 * Whether an X/Y extent reads as longitude/latitude: inside WGS84 bounds and
 * no wider than a building could be. A local frame in metres also fits the
 * bounds, but spans metres, which as degrees would be tens of kilometres.
 */
function looksGeographic([minX, minY, maxX, maxY]: number[]): boolean {
  return (
    minX >= -180 &&
    maxX <= 180 &&
    minY >= -90 &&
    maxY <= 90 &&
    Math.max(maxX - minX, maxY - minY) <= MAX_GEOGRAPHIC_SPAN
  );
}

/** The widest a building can be, in degrees, for its coordinates to read as lon/lat. */
const MAX_GEOGRAPHIC_SPAN = 0.05;

/** The first value of an attribute on `root` or any element below it. */
function firstAttribute(root: Element, name: string): string | null {
  const stack = [root];
  while (stack.length) {
    const element = stack.pop()!;
    const value = attribute(element, name);
    if (value) return value;
    const children = childElements(element);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return null;
}

/** The id an `xlink:href` points to (`#C1` → `C1`). */
function hrefId(element: Element | undefined): string | null {
  const href = element ? attribute(element, "href") : null;
  return href ? href.replace(/^.*#/, "") : null;
}

/** The floors two graph nodes are on, as one `level` value (`1`, or `1;2`). */
function joinLevels(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return a === b ? a : `${a};${b}`;
}

/**
 * Parse an IndoorGML document.
 *
 * @param text - The document's text.
 * @returns The cells, the navigation graph and what was found about CRS and floors.
 * @throws Error when the text is not XML, not IndoorGML, or holds no cell geometry.
 */
export function parseIndoorGml(text: string): IndoorGmlParseResult {
  try {
    return parseDocument(text);
  } finally {
    // The polygon index holds the parsed DOM; drop it so a large file's tree
    // is not kept alive until the next parse.
    context.polygons = new Map();
  }
}

/** {@link parseIndoorGml}'s body, run with the parse context set. */
function parseDocument(text: string): IndoorGmlParseResult {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror"))
    throw new Error("The IndoorGML file is not valid XML.");
  const root = document.documentElement;
  if (!root || localName(root) !== "IndoorFeatures") {
    throw new Error("The file does not contain an IndoorGML document (no IndoorFeatures root).");
  }

  const warnings: string[] = [];
  // The first srsName anywhere (an Envelope, a Solid, a CompositeSurface...).
  const srsName = firstAttribute(root, "srsName");
  const detectedCrs = epsgFromSrsName(srsName);
  context.swapAxes =
    !!detectedCrs && LATITUDE_FIRST.has(detectedCrs) && /^(urn:|https?:)/i.test(srsName ?? "");
  const declaredDimension = Number(firstAttribute(root, "srsDimension"));
  context.dimension =
    declaredDimension === 2 || declaredDimension === 3
      ? declaredDimension
      : descendants(root, new Set(["Geometry3D", "Solid"])).length > 0
        ? 3
        : 2;
  context.polygons = new Map();
  for (const polygon of descendants(root, POLYGON)) {
    const id = attribute(polygon, "id");
    if (id) context.polygons.set(id, polygon);
  }

  const raw: RawCell[] = [];
  for (const member of descendants(root, new Set(["cellSpaceMember"]))) {
    const cell = childElements(member).find((item) => CELL_TYPES.has(localName(item)));
    if (!cell) continue;
    const id = attribute(cell, "id") ?? `cell-${raw.length + 1}`;
    const geometry = readCellGeometry(cell);
    if (!geometry) {
      warnings.push(`Cell ${id} has no readable geometry and was skipped.`);
      continue;
    }
    raw.push({
      id,
      name: childText(cell, "name"),
      kind: localName(cell),
      className: childText(cell, "class"),
      function: childText(cell, "function"),
      usage: childText(cell, "usage"),
      storey: readStorey(cell),
      ...geometry,
    });
  }
  if (raw.length === 0) throw new Error("The IndoorGML file has no cells with geometry.");

  // Elevations are measured from the lowest point of the building, so the
  // cells stand on the map's ground.
  const zero = extremes(raw.map((cell) => cell.minZ))[0];
  const levelSource = raw.some((cell) => cell.storey !== null)
    ? "storey"
    : raw.some((cell) => cell.has3d)
      ? "elevation"
      : "none";
  const floors =
    levelSource === "elevation"
      ? floorsFromElevations(
          raw.map((cell) => cell.minZ),
          0,
        )
      : null;
  const levelOf = new Map<string, string | null>();
  raw.forEach((cell, index) => levelOf.set(cell.id, floors ? String(floors[index]) : cell.storey));

  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  const track = (position: Position) => {
    extent[0] = Math.min(extent[0], position[0]);
    extent[1] = Math.min(extent[1], position[1]);
    extent[2] = Math.max(extent[2], position[0]);
    extent[3] = Math.max(extent[3], position[1]);
  };

  const cells: Feature[] = raw.map((cell) => {
    cell.footprint.flat(2).forEach(track);
    const base = cell.minZ - zero;
    const top = cell.has3d ? cell.maxZ - zero : base + DEFAULT_CELL_HEIGHT;
    return {
      type: "Feature",
      id: cell.id,
      geometry:
        cell.footprint.length === 1
          ? { type: "Polygon", coordinates: cell.footprint[0] }
          : { type: "MultiPolygon", coordinates: cell.footprint },
      properties: {
        id: cell.id,
        name: cell.name,
        kind: cell.kind,
        class: cell.className,
        function: cell.function,
        usage: cell.usage,
        level: levelOf.get(cell.id) ?? null,
        base_z: Number(base.toFixed(3)),
        top_z: Number(Math.max(top, base + 0.1).toFixed(3)),
      },
    };
  });

  const shift = (position: Position): Position => {
    track(position);
    return position.length > 2
      ? [position[0], position[1], Number((position[2] - zero).toFixed(3))]
      : [position[0], position[1]];
  };

  // A state names its cell (duality); some documents only say it the other
  // way round, from the cell to its state.
  const cellOfState = new Map<string, string>();
  for (const member of descendants(root, new Set(["cellSpaceMember"]))) {
    const cell = childElements(member).find((item) => CELL_TYPES.has(localName(item)));
    const stateId = cell ? hrefId(child(cell, "duality")) : null;
    const cellId = cell ? attribute(cell, "id") : null;
    if (stateId && cellId) cellOfState.set(stateId, cellId);
  }
  const stateLevel = new Map<string, string | null>();
  const states: Feature[] = [];
  for (const state of descendants(root, new Set(["State"]))) {
    const id = attribute(state, "id") ?? `state-${states.length + 1}`;
    const point = descendants(state, new Set(["Point"]))[0];
    const position = point ? readPositions(point)[0] : undefined;
    const cellId = hrefId(child(state, "duality")) ?? cellOfState.get(id) ?? null;
    const level = cellId ? (levelOf.get(cellId) ?? null) : null;
    stateLevel.set(id, level);
    if (!position) continue;
    states.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: shift(position) },
      properties: { id, name: childText(state, "name"), cell: cellId, level },
    });
  }

  const transitions: Feature[] = [];
  for (const transition of descendants(root, new Set(["Transition"]))) {
    const id = attribute(transition, "id") ?? `transition-${transitions.length + 1}`;
    const line = descendants(transition, new Set(["LineString"]))[0];
    const positions = line ? readPositions(line) : [];
    if (positions.length < 2) continue;
    const ends = childElements(transition)
      .filter((item) => localName(item) === "connects")
      .map(hrefId);
    const weightText = childText(transition, "weight");
    const weight = weightText === null ? NaN : Number(weightText);
    transitions.push({
      type: "Feature",
      id,
      geometry: { type: "LineString", coordinates: positions.map(shift) },
      properties: {
        id,
        name: childText(transition, "name"),
        from: ends[0] ?? null,
        to: ends[1] ?? null,
        weight: Number.isFinite(weight) ? weight : null,
        level: joinLevels(
          ends[0] ? (stateLevel.get(ends[0]) ?? null) : null,
          ends[1] ? (stateLevel.get(ends[1]) ?? null) : null,
        ),
      },
    });
  }

  // The floors themselves: a staircase's `1-2` is floors 1 and 2, not a
  // floor of its own (the floor picker expands it the same way), lowest first.
  const tokens = new Map<string, number | null>();
  for (const cell of raw) {
    for (const token of parseLevelValue(levelOf.get(cell.id) ?? null)) {
      tokens.set(token.label, token.ordinal);
    }
  }
  const levels = [...tokens.entries()]
    .sort(([a, ao], [b, bo]) =>
      ao !== null && bo !== null
        ? ao - bo
        : ao !== null
          ? -1
          : bo !== null
            ? 1
            : a.localeCompare(b),
    )
    .map(([label]) => label);
  return {
    cells: { type: "FeatureCollection", features: cells },
    states: { type: "FeatureCollection", features: states },
    transitions: { type: "FeatureCollection", features: transitions },
    ...(detectedCrs ? { detectedCrs } : {}),
    coordinatesLookGeographic: looksGeographic(extent),
    levelSource,
    levels,
    warnings,
  };
}

/** Metres per degree of latitude (mean). */
const METRES_PER_DEGREE = 111_320;

/**
 * Place collections in a local building frame (X/Y in metres, no CRS) on the
 * map: the centre of their combined extent goes to `center`, and metres become
 * degrees around it. Good for viewing a model with no georeference, not for
 * measuring where it is.
 *
 * @param collections - Collections in the same local frame.
 * @param center - Where the model's centre goes, as `[lng, lat]`.
 * @returns The collections in longitude/latitude, Z kept.
 */
export function placeLocalCoordinates(
  collections: readonly FeatureCollection[],
  center: [number, number],
): FeatureCollection[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (value: unknown, fn: (position: Position) => Position): unknown =>
    Array.isArray(value) && typeof value[0] === "number"
      ? fn(value as Position)
      : Array.isArray(value)
        ? value.map((item) => visit(item, fn))
        : value;
  for (const collection of collections) {
    for (const feature of collection.features) {
      const geometry = feature.geometry as { coordinates?: unknown } | null;
      visit(geometry?.coordinates, (position) => {
        minX = Math.min(minX, position[0]);
        maxX = Math.max(maxX, position[0]);
        minY = Math.min(minY, position[1]);
        maxY = Math.max(maxY, position[1]);
        return position;
      });
    }
  }
  if (!Number.isFinite(minX)) return [...collections];
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const perLng = METRES_PER_DEGREE * Math.cos((center[1] * Math.PI) / 180);
  const place = (position: Position): Position => [
    center[0] + (position[0] - cx) / perLng,
    center[1] + (position[1] - cy) / METRES_PER_DEGREE,
    ...position.slice(2),
  ];
  return collections.map((collection) => ({
    ...collection,
    features: collection.features.map((feature) => {
      if (!feature.geometry) return feature;
      const geometry = feature.geometry as { type: string; coordinates: unknown };
      return {
        ...feature,
        geometry: { ...geometry, coordinates: visit(geometry.coordinates, place) },
      } as Feature;
    }),
  }));
}
