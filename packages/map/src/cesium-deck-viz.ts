import {
  CZML_SOURCE_KIND,
  DEFAULT_LAYER_STYLE,
  type CzmlPacket,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

// Deck.gl visualizations (issue #2261) on the Cesium globe. deck.gl has no
// Cesium interop, so instead of running deck there, each Deck.gl Layer builder
// record is rewritten into a layer the globe already draws: a FeatureCollection
// for the GeoJSON path (points, labels, flows, trips, extruded bins) or a CZML
// document for glTF models. The record's styling follows the same Style panel
// bridge the 2D overlay reads (`deckgl-viz/overlay.ts`): fill colour, radius,
// and line width from the live LayerStyle, the rest from `metadata.vizConfig`.
//
// The 2D-only kinds are the screen-space and density ones (heatmap, screen
// grid, contour), which have no globe primitive to map onto.
//
// The plugin package owns the viz registry, but @geolibre/map cannot import
// @geolibre/plugins, so the persisted record shape and the few accessors the
// globe needs are read here directly.

/** Marks a derived globe record, so the layer sync can tell it from a native one. */
export const DECK_VIZ_GLOBE_METADATA_KEY = "deckVizGlobe";

/** The `metadata.sourceKind` the Deck.gl Layer builder stamps on its records. */
const DECK_VIZ_SOURCE_KIND = "deckgl-viz";

/** The deck.gl visualization kinds the globe draws. */
const GLOBE_DECK_VIZ_KINDS: ReadonlySet<string> = new Set([
  "scatterplot",
  "icon",
  "text",
  "arc",
  "line",
  "great-circle",
  "trips",
  "hexagon",
  "grid",
  "geojson",
  "scenegraph",
]);

/**
 * The deck viz style defaults, mirroring `DEFAULT_DECK_VIZ_STYLE` in the plugin
 * registry (`tests/cesium-deck-viz.test.ts` pins the two together).
 */
export const DEFAULT_VIZ_STYLE = {
  color: "#3b82f6",
  radius: 40,
  cellSize: 1000,
  lineWidth: 2,
  extruded: false,
  elevationScale: 30,
};

/** The aggregation layers' yellow-to-red ramp, mirroring the registry's `COLOR_RANGE`. */
export const COLOR_RANGE = ["#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026"];

/**
 * Screen radius of a scatterplot dot. deck.gl sizes them in metres with a 1 px
 * floor; the globe's point graphics are screen-space only, so a fixed dot
 * stands in for the metre radius, which reads as a few pixels at city scale.
 */
const SCATTER_DOT_RADIUS_PX = 2;

/** Vertices along one arc; deck.gl's ArcLayer tessellates with 50 segments. */
const ARC_SEGMENTS = 32;

/** Peak height of an arc as a fraction of its ground length. */
const ARC_HEIGHT_RATIO = 0.25;

/** deck.gl's default `elevationRange` upper bound for the aggregation layers. */
const AGGREGATION_ELEVATION_RANGE = 1000;

/** Metres per degree of latitude on the WGS84 sphere deck.gl's aggregators assume. */
const METERS_PER_DEGREE = 111_320;

/** Whole-model floor, in pixels, for a model whose 2D record keeps a size floor. */
const MODEL_MINIMUM_PIXEL_SIZE = 48;

/** Feature property holding a bin's or feature's colour. */
const COLOR_PROPERTY = "geolibre:color";
/** Feature property holding a bin's extrusion height in metres. */
const ELEVATION_PROPERTY = "geolibre:elevation";
/** Feature property holding a text label. */
const LABEL_PROPERTY = "geolibre:label";

type FieldMapping = Record<string, string | number>;
type Row = Record<string | number, unknown>;

interface VizConfig {
  layerKind: string;
  fieldMapping: FieldMapping;
  style: typeof DEFAULT_VIZ_STYLE;
  scenegraph?: {
    modelUrl?: unknown;
    sizeScale?: unknown;
    sizeMinPixels?: unknown;
    bearing?: unknown;
    altitude?: unknown;
  };
}

/**
 * Whether a store layer is a Deck.gl Layer builder record.
 *
 * @param layer - A store layer.
 * @returns True for a `deckgl-viz` record the builder created.
 */
export function isDeckVizRecord(layer: GeoLibreLayer): boolean {
  return layer.type === "deckgl-viz" && layer.metadata?.sourceKind === DECK_VIZ_SOURCE_KIND;
}

/**
 * Reads the persisted viz config, or null when it is missing or malformed.
 *
 * @param layer - A deck viz store layer.
 * @returns The config with defaults filled in, or null.
 */
function readVizConfig(layer: GeoLibreLayer): VizConfig | null {
  const raw = layer.metadata?.vizConfig;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<VizConfig>;
  if (typeof candidate.layerKind !== "string") return null;
  if (!candidate.fieldMapping || typeof candidate.fieldMapping !== "object") return null;
  return {
    layerKind: candidate.layerKind,
    fieldMapping: candidate.fieldMapping,
    style: { ...DEFAULT_VIZ_STYLE, ...(candidate.style ?? {}) },
    scenegraph:
      candidate.scenegraph && typeof candidate.scenegraph === "object"
        ? candidate.scenegraph
        : undefined,
  };
}

/**
 * Whether the globe can draw this deck viz record's kind.
 *
 * @param layer - A store layer.
 * @returns True for a builder record whose kind has a globe form.
 */
export function isGlobeDeckVizLayer(layer: GeoLibreLayer): boolean {
  if (!isDeckVizRecord(layer)) return false;
  const config = readVizConfig(layer);
  if (config === null || !GLOBE_DECK_VIZ_KINDS.has(config.layerKind)) return false;
  // The same data deckVizGlobeLayer converts: without it there is nothing to
  // rewrite, and calling the layer globe-capable would report it as broken.
  return dataOwner(layer, config) !== undefined;
}

/** The array or FeatureCollection a record's globe form is derived from. */
function dataOwner(layer: GeoLibreLayer, config: VizConfig): object | undefined {
  const owner: unknown =
    config.layerKind === "geojson" ? layer.geojson : (layer.source as { data?: unknown }).data;
  return owner && typeof owner === "object" ? owner : undefined;
}

/** Reads `record[key]` as a number, or NaN when missing or blank. */
function readNumber(record: Row, key: string | number | undefined): number {
  if (key === undefined || key === "") return Number.NaN;
  const value = record[key];
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

/** A `[lng, lat]` read from two mapped roles, or null when either is invalid. */
function readPosition(
  record: Row,
  mapping: FieldMapping,
  lngRole = "lng",
  latRole = "lat",
): [number, number] | null {
  const lng = readNumber(record, mapping[lngRole]);
  const lat = readNumber(record, mapping[latRole]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -360 || lng > 360) return null;
  return [lng, lat];
}

/** The record's own fields as feature properties (tuple rows have none worth keeping). */
function rowProperties(record: Row): Record<string, unknown> {
  return Array.isArray(record) ? {} : { ...record };
}

/** The inline rows of a deck viz record. */
function rowsOf(layer: GeoLibreLayer): Row[] {
  const data = (layer.source as { data?: unknown }).data;
  return Array.isArray(data)
    ? (data.filter((row) => row !== null && typeof row === "object") as Row[])
    : [];
}

function feature(geometry: Geometry, properties: Record<string, unknown>): Feature {
  return { type: "Feature", geometry, properties };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** One point feature per row with a valid position. */
function pointFeatures(rows: Row[], mapping: FieldMapping): Feature[] {
  const features: Feature[] = [];
  for (const row of rows) {
    const position = readPosition(row, mapping);
    if (position)
      features.push(feature({ type: "Point", coordinates: position }, rowProperties(row)));
  }
  return features;
}

/** One labelled point per row, the label read from the mapped `text` role. */
function textFeatures(rows: Row[], mapping: FieldMapping): Feature[] {
  const key = mapping.text;
  const features: Feature[] = [];
  for (const row of rows) {
    const position = readPosition(row, mapping);
    if (!position) continue;
    const label = key === undefined ? "" : String(row[key] ?? "");
    features.push(
      feature(
        { type: "Point", coordinates: position },
        { ...rowProperties(row), [LABEL_PROPERTY]: label },
      ),
    );
  }
  return features;
}

/**
 * Great-circle interpolation between two `[lng, lat]` points.
 *
 * @param from - Start position in degrees.
 * @param to - End position in degrees.
 * @param t - Fraction along the path, 0..1.
 * @returns The interpolated `[lng, lat]`.
 */
export function interpolateGreatCircle(
  from: [number, number],
  to: [number, number],
  t: number,
): [number, number] {
  const rad = Math.PI / 180;
  const [lng1, lat1] = [from[0] * rad, from[1] * rad];
  const [lng2, lat2] = [to[0] * rad, to[1] * rad];
  const a = [Math.cos(lat1) * Math.cos(lng1), Math.cos(lat1) * Math.sin(lng1), Math.sin(lat1)];
  const b = [Math.cos(lat2) * Math.cos(lng2), Math.cos(lat2) * Math.sin(lng2), Math.sin(lat2)];
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-12) return [from[0], from[1]];
  const sinOmega = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / sinOmega;
  const wb = Math.sin(t * omega) / sinOmega;
  const x = wa * a[0] + wb * b[0];
  const y = wa * a[1] + wb * b[1];
  const z = wa * a[2] + wb * b[2];
  return [Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad];
}

/** Ground distance in metres between two `[lng, lat]` points (haversine). */
function groundDistance(from: [number, number], to: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (to[1] - from[1]) * rad;
  const dLng = (to[0] - from[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from[1] * rad) * Math.cos(to[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Origin-destination flows as lines. Arcs rise off the ground as a parabola
 * over the great circle, the way deck.gl's ArcLayer lifts them; lines and
 * great circles stay on the ground, where Cesium already draws a two-point
 * polyline as a geodesic.
 */
function flowFeatures(rows: Row[], mapping: FieldMapping, arc: boolean): Feature[] {
  const features: Feature[] = [];
  for (const row of rows) {
    const source = readPosition(row, mapping, "sourceLng", "sourceLat");
    const target = readPosition(row, mapping, "targetLng", "targetLat");
    if (!source || !target) continue;
    let coordinates: Position[];
    if (arc) {
      const peak = groundDistance(source, target) * ARC_HEIGHT_RATIO;
      coordinates = [];
      for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
        const t = i / ARC_SEGMENTS;
        const [lng, lat] = interpolateGreatCircle(source, target, t);
        coordinates.push([lng, lat, 4 * peak * t * (1 - t)]);
      }
    } else {
      coordinates = [source, target];
    }
    features.push(feature({ type: "LineString", coordinates }, rowProperties(row)));
  }
  return features;
}

/** Each trip's whole path as a static line (the trail animation stays in 2D). */
function tripFeatures(rows: Row[], mapping: FieldMapping): Feature[] {
  const key = mapping.path;
  const features: Feature[] = [];
  if (key === undefined) return features;
  for (const row of rows) {
    const path = row[key];
    if (!Array.isArray(path)) continue;
    // Drop any Z: a trip's third ordinate is not a height, and a Z would lift
    // the whole collection off the ground.
    const coordinates = path
      .filter(
        (point): point is number[] =>
          Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
      )
      .map((point) => [Number(point[0]), Number(point[1])]);
    if (coordinates.length < 2) continue;
    const properties = rowProperties(row);
    // The path and timestamps arrays would only bloat every entity's properties.
    delete properties[String(key)];
    if (mapping.timestamps !== undefined) delete properties[String(mapping.timestamps)];
    features.push(feature({ type: "LineString", coordinates }, properties));
  }
  return features;
}

interface Bin {
  ring: Position[];
  value: number;
}

/**
 * Aggregates rows into square or hexagonal bins, `cellSize` metres across,
 * the way deck.gl's GridLayer and HexagonLayer do: each bin's value is the
 * row count, or the sum of the weight column when one is mapped. Cells are
 * laid out in a local equirectangular frame scaled at the data's mean
 * latitude, which is the approximation deck.gl's aggregators make too.
 *
 * @param rows - The inline rows.
 * @param mapping - The field mapping (lng, lat, optional weight).
 * @param cellSize - Cell size (grid) or hexagon radius in metres.
 * @param hexagon - Hexagonal bins instead of square ones.
 * @returns The non-empty bins with their outer rings.
 */
export function aggregateBins(
  rows: Row[],
  mapping: FieldMapping,
  cellSize: number,
  hexagon: boolean,
): Bin[] {
  const points: { lng: number; lat: number; weight: number }[] = [];
  const weightKey = mapping.weight;
  const weighted = weightKey !== undefined && weightKey !== "";
  let latSum = 0;
  for (const row of rows) {
    const position = readPosition(row, mapping);
    if (!position) continue;
    const weight = weighted ? readNumber(row, weightKey) : 1;
    points.push({
      lng: position[0],
      lat: position[1],
      weight: Number.isFinite(weight) ? weight : 0,
    });
    latSum += position[1];
  }
  if (points.length === 0 || !(cellSize > 0)) return [];
  const meanLat = latSum / points.length;
  // Degrees per metre east and north at the mean latitude.
  const cosLat = Math.max(Math.cos((meanLat * Math.PI) / 180), 1e-6);
  const degX = 1 / (METERS_PER_DEGREE * cosLat);
  const degY = 1 / METERS_PER_DEGREE;
  const bins = new Map<string, { cx: number; cy: number; value: number }>();
  const add = (key: string, cx: number, cy: number, weight: number): void => {
    const bin = bins.get(key);
    if (bin) bin.value += weight;
    else bins.set(key, { cx, cy, value: weight });
  };
  if (hexagon) {
    // Pointy-top hexagons of circumradius `cellSize`: columns are sqrt(3)·r
    // apart and rows 1.5·r, odd rows shifted half a column.
    const r = cellSize;
    const w = Math.sqrt(3) * r;
    const h = 1.5 * r;
    for (const p of points) {
      const x = p.lng / degX;
      const y = p.lat / degY;
      const row = Math.round(y / h);
      const col = Math.round(x / w - (row & 1) / 2);
      // The nearest centre by rounding can miss across a slanted edge, so
      // settle on the closest of the candidate and its neighbours.
      let best = { row, col, d: Infinity };
      for (let dr = -1; dr <= 1; dr += 1) {
        const rr = row + dr;
        for (let dc = -1; dc <= 1; dc += 1) {
          const cc = col + dc;
          const cx = (cc + (rr & 1) / 2) * w;
          const cy = rr * h;
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d < best.d) best = { row: rr, col: cc, d };
        }
      }
      const cx = (best.col + (best.row & 1) / 2) * w;
      add(`${best.row}:${best.col}`, cx, best.row * h, p.weight);
    }
    return [...bins.values()].map((bin) => {
      const ring: Position[] = [];
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        ring.push([(bin.cx + r * Math.cos(angle)) * degX, (bin.cy + r * Math.sin(angle)) * degY]);
      }
      ring.push(ring[0]);
      return { ring, value: bin.value };
    });
  }
  for (const p of points) {
    const col = Math.floor(p.lng / degX / cellSize);
    const row = Math.floor(p.lat / degY / cellSize);
    add(`${row}:${col}`, col * cellSize, row * cellSize, p.weight);
  }
  return [...bins.values()].map((bin) => {
    const [x0, y0] = [bin.cx * degX, bin.cy * degY];
    const [x1, y1] = [(bin.cx + cellSize) * degX, (bin.cy + cellSize) * degY];
    return {
      ring: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
      value: bin.value,
    };
  });
}

/**
 * Binned polygons coloured by quantizing each bin's value over the ramp and
 * raised by a linear map of the value onto deck.gl's 0..1000 m elevation
 * range, times the elevation scale.
 */
function binFeatures(rows: Row[], config: VizConfig, hexagon: boolean): Feature[] {
  const bins = aggregateBins(rows, config.fieldMapping, config.style.cellSize, hexagon);
  if (bins.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const bin of bins) {
    if (bin.value < min) min = bin.value;
    if (bin.value > max) max = bin.value;
  }
  const span = max - min;
  const elevationScale = config.style.extruded ? config.style.elevationScale : 0;
  return bins.map((bin) => {
    const t = span > 0 ? (bin.value - min) / span : 1;
    const color = COLOR_RANGE[Math.min(COLOR_RANGE.length - 1, Math.floor(t * COLOR_RANGE.length))];
    return feature(
      { type: "Polygon", coordinates: [bin.ring] },
      {
        value: bin.value,
        [COLOR_PROPERTY]: color,
        [ELEVATION_PROPERTY]: t * AGGREGATION_ELEVATION_RANGE * elevationScale,
      },
    );
  });
}

/**
 * The East-North-Up frame's rotation at a position, turned by a heading, as a
 * unit quaternion in Earth-fixed coordinates: what Cesium's
 * `Transforms.headingPitchRollQuaternion` returns for a zero pitch and roll.
 * Computed here so a CZML packet can carry it without the engine loaded.
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @param bearing - Heading in degrees clockwise from north.
 * @returns `[x, y, z, w]`.
 */
export function headingQuaternion(lng: number, lat: number, bearing: number): number[] {
  const rad = Math.PI / 180;
  const [sl, cl] = [Math.sin(lng * rad), Math.cos(lng * rad)];
  const [sp, cp] = [Math.sin(lat * rad), Math.cos(lat * rad)];
  const east = [-sl, cl, 0];
  const north = [-sp * cl, -sp * sl, cp];
  const up = [cp * cl, cp * sl, sp];
  // Cesium's heading turns the model's +X (its nose) clockwise from east, so a
  // bearing measured clockwise from north is a heading 90° less.
  const heading = (bearing - 90) * rad;
  const [ch, sh] = [Math.cos(heading), Math.sin(heading)];
  const xAxis = [0, 1, 2].map((i) => ch * east[i] - sh * north[i]);
  const yAxis = [0, 1, 2].map((i) => sh * east[i] + ch * north[i]);
  // Rotation matrix with columns xAxis, yAxis, up → quaternion.
  const m = [
    [xAxis[0], yAxis[0], up[0]],
    [xAxis[1], yAxis[1], up[1]],
    [xAxis[2], yAxis[2], up[2]],
  ];
  const trace = m[0][0] + m[1][1] + m[2][2];
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m[2][1] - m[1][2]) / s;
    y = (m[0][2] - m[2][0]) / s;
    z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s;
    x = s / 4;
    y = (m[0][1] + m[1][0]) / s;
    z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s;
    x = (m[0][1] + m[1][0]) / s;
    y = s / 4;
    z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s;
    x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s;
    z = s / 4;
  }
  return [x, y, z, w];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A CZML document placing the record's glTF model at every row, with the
 * row's altitude, bearing, and scale columns when mapped. deck.gl's constant
 * translation and roll have no counterpart: Cesium reads glTF's Y-up axis
 * itself, so the roll deck.gl needs to stand a model upright is not applied.
 */
function scenegraphPackets(layer: GeoLibreLayer, rows: Row[], config: VizConfig): CzmlPacket[] {
  const sg = config.scenegraph ?? {};
  const modelUrl = typeof sg.modelUrl === "string" ? sg.modelUrl.trim() : "";
  if (!modelUrl) return [];
  const mapping = config.fieldMapping;
  const sizeScale = finiteOr(sg.sizeScale, 1);
  const baseBearing = finiteOr(sg.bearing, 0);
  const baseAltitude = finiteOr(sg.altitude, 0);
  // Projects saved before the dialog wrote a floor default to 1 px per model
  // unit; only an explicit 0 drops it.
  const keepFloor = finiteOr(sg.sizeMinPixels, 1) > 0;
  const packets: CzmlPacket[] = [{ id: "document", name: layer.name, version: "1.0" }];
  rows.forEach((row, index) => {
    const position = readPosition(row, mapping);
    if (!position) return;
    const altitude = readNumber(row, mapping.altitude);
    const bearing = readNumber(row, mapping.bearing);
    const scale = readNumber(row, mapping.scale);
    const [lng, lat] = position;
    packets.push({
      id: `${layer.id}:${index}`,
      position: {
        cartographicDegrees: [lng, lat, (Number.isFinite(altitude) ? altitude : 0) + baseAltitude],
      },
      orientation: {
        unitQuaternion: headingQuaternion(
          lng,
          lat,
          Number.isFinite(bearing) ? bearing : baseBearing,
        ),
      },
      model: {
        gltf: modelUrl,
        scale: sizeScale * (Number.isFinite(scale) && scale !== 0 ? scale : 1),
        minimumPixelSize: keepFloor ? MODEL_MINIMUM_PIXEL_SIZE : 0,
        heightReference: "RELATIVE_TO_GROUND",
      },
      properties: rowProperties(row),
    });
  });
  return packets.length > 1 ? packets : [];
}

/** Derived data, cached per data array and the config fields it reads. */
const dataCache = new WeakMap<object, { key: string; value: FeatureCollection | CzmlPacket[] }>();

/**
 * Builds (or reuses) the derived FeatureCollection or CZML document. Keyed on
 * the data array's identity and the config that shapes it, so a store update
 * that only moves opacity or visibility hands the layer sync the same object
 * and does not rebuild the globe's data source.
 */
function derivedData(
  layer: GeoLibreLayer,
  config: VizConfig,
): FeatureCollection | CzmlPacket[] | null {
  const isGeoJson = config.layerKind === "geojson";
  const owner = dataOwner(layer, config);
  if (!owner) return null;
  const key = JSON.stringify({
    kind: config.layerKind,
    mapping: config.fieldMapping,
    cellSize: config.style.cellSize,
    extruded: config.style.extruded,
    elevationScale: config.style.elevationScale,
    scenegraph: config.layerKind === "scenegraph" ? config.scenegraph : undefined,
    // CZML packet ids carry the layer id and the name.
    id: config.layerKind === "scenegraph" ? layer.id : undefined,
    name: config.layerKind === "scenegraph" ? layer.name : undefined,
  });
  const cached = dataCache.get(owner);
  if (cached?.key === key) return cached.value;
  const rows = isGeoJson ? [] : rowsOf(layer);
  let value: FeatureCollection | CzmlPacket[];
  switch (config.layerKind) {
    case "scatterplot":
    case "icon":
      value = collection(pointFeatures(rows, config.fieldMapping));
      break;
    case "text":
      value = collection(textFeatures(rows, config.fieldMapping));
      break;
    case "arc":
      value = collection(flowFeatures(rows, config.fieldMapping, true));
      break;
    case "line":
    case "great-circle":
      value = collection(flowFeatures(rows, config.fieldMapping, false));
      break;
    case "trips":
      value = collection(tripFeatures(rows, config.fieldMapping));
      break;
    case "hexagon":
    case "grid":
      value = collection(binFeatures(rows, config, config.layerKind === "hexagon"));
      break;
    case "geojson":
      value = layer.geojson as FeatureCollection;
      break;
    case "scenegraph":
      value = scenegraphPackets(layer, rows, config);
      break;
    default:
      return null;
  }
  dataCache.set(owner, { key, value });
  return value;
}

/** The record's live style, bridged the way the 2D overlay reads it. */
function bridgedStyle(layer: GeoLibreLayer, config: VizConfig) {
  const style = layer.style ?? DEFAULT_LAYER_STYLE;
  return {
    color: style.fillColor || config.style.color,
    radius: Number.isFinite(style.circleRadius) ? style.circleRadius : config.style.radius,
    lineWidth: Number.isFinite(style.strokeWidth) ? style.strokeWidth : config.style.lineWidth,
  };
}

/** A label style showing {@link LABEL_PROPERTY} in the record's colour. */
function labelStyle(color: string): LayerStyle["labels"] {
  return {
    ...DEFAULT_LAYER_STYLE.labels,
    enabled: true,
    field: LABEL_PROPERTY,
    expression: "",
    size: 16,
    color,
    haloColor: "#ffffff",
    haloWidth: 2,
  };
}

/** The globe style for a derived GeoJSON record. */
function globeStyle(layer: GeoLibreLayer, config: VizConfig): LayerStyle {
  const base: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  const { color, radius, lineWidth } = bridgedStyle(layer, config);
  const reset: Partial<LayerStyle> = {
    // The 2D record's style only seeds colour, radius and width; nothing else
    // the panel offers reaches the deck layer, so none of it reaches the globe.
    vectorStyleMode: "single",
    markerEnabled: false,
    pointRenderer: "single",
    extrusionEnabled: false,
    labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: false },
    minZoom: base.minZoom,
    maxZoom: base.maxZoom,
    fillOpacity: base.fillOpacity,
  };
  switch (config.layerKind) {
    case "scatterplot":
      return {
        ...base,
        ...reset,
        fillColor: color,
        strokeColor: color,
        strokeWidth: 0,
        circleRadius: radius > 0 ? SCATTER_DOT_RADIUS_PX : 0,
      };
    case "icon":
      return {
        ...base,
        ...reset,
        fillColor: color,
        strokeColor: color,
        strokeWidth: 0,
        markerEnabled: true,
        markerShape: "pin",
        markerColor: color,
        markerSize: Math.max(radius, 12),
      };
    case "text":
      return {
        ...base,
        ...reset,
        fillColor: color,
        strokeColor: color,
        strokeWidth: 0,
        circleRadius: 0,
        labels: labelStyle(color),
      };
    case "arc":
    case "line":
    case "great-circle":
    case "trips":
      return {
        ...base,
        ...reset,
        fillColor: color,
        strokeColor: color,
        strokeWidth: Math.max(lineWidth, 1),
        strokeWidthUnit: "pixels",
      };
    case "hexagon":
    case "grid": {
      const expression = JSON.stringify(["get", COLOR_PROPERTY]);
      return {
        ...base,
        ...reset,
        vectorStyleMode: "expression",
        vectorStyleExpression: expression,
        strokeWidth: 0,
        fillOpacity: 1,
        extrusionEnabled: config.style.extruded,
        extrusionAdvancedStyleEnabled: true,
        extrusionHeightExpression: JSON.stringify(["get", ELEVATION_PROPERTY]),
        extrusionColorExpression: expression,
        extrusionHeightScale: 1,
        extrusionBase: 0,
        extrusionOpacity: 1,
      };
    }
    case "geojson": {
      const elevationKey = config.fieldMapping.elevation;
      const extruded =
        config.style.extruded && typeof elevationKey === "string" && elevationKey !== "";
      return {
        ...base,
        ...reset,
        fillColor: color,
        strokeColor: color,
        strokeWidth: Math.max(lineWidth, 1),
        strokeWidthUnit: "pixels",
        fillOpacity: 0.7 * base.fillOpacity,
        circleRadius: SCATTER_DOT_RADIUS_PX,
        extrusionEnabled: extruded,
        extrusionAdvancedStyleEnabled: false,
        extrusionHeightProperty: extruded ? elevationKey : "",
        extrusionHeightScale: 1,
        extrusionBase: 0,
        extrusionColor: color,
      };
    }
    default:
      return base;
  }
}

/** Derived records, cached per store record so an unchanged layer maps to the same object. */
const globeLayerCache = new WeakMap<GeoLibreLayer, GeoLibreLayer | null>();

/**
 * The layer the globe draws in place of a Deck.gl Layer builder record: a
 * `geojson` record carrying a FeatureCollection, or a CZML record for a glTF
 * model layer. It keeps the store record's id, name, visibility, opacity, and
 * zoom range, so picking, highlighting, and "Zoom to layer" resolve to the
 * same layer.
 *
 * @param layer - A store layer.
 * @returns The derived record, or null when the layer is not a deck viz
 *   record the globe can draw (its kind is 2D-only, or its config is broken).
 */
export function deckVizGlobeLayer(layer: GeoLibreLayer): GeoLibreLayer | null {
  if (!isDeckVizRecord(layer)) return null;
  const cached = globeLayerCache.get(layer);
  if (cached !== undefined) return cached;
  const config = readVizConfig(layer);
  let derived: GeoLibreLayer | null = null;
  if (config && GLOBE_DECK_VIZ_KINDS.has(config.layerKind)) {
    const data = derivedData(layer, config);
    if (data) derived = derivedRecord(layer, config, data);
  }
  globeLayerCache.set(layer, derived);
  return derived;
}

function derivedRecord(
  layer: GeoLibreLayer,
  config: VizConfig,
  data: FeatureCollection | CzmlPacket[],
): GeoLibreLayer {
  const {
    customLayerType: _customLayerType,
    externalDeckLayer: _externalDeckLayer,
    vizConfig: _vizConfig,
    sourceKind: _sourceKind,
    ...metadata
  } = layer.metadata ?? {};
  if (Array.isArray(data)) {
    return {
      ...layer,
      source: { type: "czml", czmlData: data },
      geojson: undefined,
      metadata: {
        ...metadata,
        sourceKind: CZML_SOURCE_KIND,
        [DECK_VIZ_GLOBE_METADATA_KEY]: config.layerKind,
      },
    };
  }
  return {
    ...layer,
    type: "geojson",
    source: { type: "geojson" },
    geojson: data,
    style: globeStyle(layer, config),
    metadata: {
      ...metadata,
      [DECK_VIZ_GLOBE_METADATA_KEY]: config.layerKind,
    },
  };
}
