import type { Layer } from "@deck.gl/core";
import type { FeatureCollection } from "geojson";
import { colorToRgba } from "../deck-style-utils";
import type { GeoLibreDeckGL } from "../../types";

/**
 * Registry of deck.gl layer types a user can build from an uploaded file or a
 * URL. Each entry declares the input it expects, the field roles the dialog
 * must collect, a `build` function that turns parsed data + a field mapping
 * into a deck.gl layer, and a bundled example (the real deck.gl-data file) so
 * "Use example data" renders with zero configuration.
 */

/** Visual grouping shown in the layer-type picker. */
export type DeckVizCategory = "point" | "flow" | "geojson" | "advanced" | "models";

/**
 * How the source data is shaped. Drives both the dialog (file picker vs URL
 * fields, CSV vs JSON parsing) and the accessors used by `build`.
 */
export type DeckVizInputKind =
  | "point-csv" // CSV rows with lng/lat columns
  | "json-array" // JSON array of [lng, lat, weight?] tuples
  | "od-csv" // CSV rows with source/target lng/lat columns
  | "geojson" // GeoJSON FeatureCollection
  | "json-objects"; // JSON array of objects (e.g. trips paths)

/** How parsed data is persisted on the store layer. */
export type DeckVizFormat = "csv-rows" | "json-array" | "json-objects" | "geojson";

/**
 * A single field the user maps to a data column (named CSV/object key) or a
 * tuple index (JSON array). Accessors read `record[key]`, which works for both
 * an object (`record["lng"]`) and an array (`record[0]`).
 */
export interface DeckVizRole {
  key: string;
  label: string;
  required: boolean;
  /** Lowercased substrings used to auto-detect the matching column. */
  detect: string[];
}

/** Optional styling control the dialog renders for a layer. */
export type DeckVizStyleControl = "color" | "radius" | "cellSize" | "lineWidth" | "extruded";

/** User-tunable visual style, persisted in the layer's vizConfig. */
export interface DeckVizStyle {
  color: string;
  radius: number;
  cellSize: number;
  lineWidth: number;
  extruded: boolean;
  elevationScale: number;
}

export const DEFAULT_DECK_VIZ_STYLE: DeckVizStyle = {
  color: "#3b82f6",
  radius: 40,
  cellSize: 1000,
  lineWidth: 2,
  extruded: false,
  elevationScale: 30,
};

/** Maps a role key to a column name (string) or tuple index (number). */
export type DeckVizFieldMapping = Record<string, string | number>;

/**
 * Configuration specific to the glTF 3D-model (`scenegraph`) layer: the model
 * URL plus the default transform applied to every instance. Per-instance
 * altitude/bearing/scale can additionally be data-driven via mapped columns.
 */
export interface DeckVizScenegraphConfig {
  /** glTF/GLB model URL (the model itself, not the placement data). */
  modelUrl: string;
  /** Overall size multiplier in meters (ScenegraphLayer `sizeScale`). */
  sizeScale: number;
  /** Minimum rendered pixels for one model unit. */
  sizeMinPixels?: number;
  /** Heading in degrees clockwise from north, applied as the model's yaw. */
  bearing: number;
  /** Extra roll in degrees applied after yaw. Defaults to deck.gl's glTF example. */
  orientationRoll?: number;
  /** Constant translation from the anchor point, [x, y, z] in meters. */
  translation?: [number, number, number];
  /**
   * Constant altitude in meters, added to the per-instance altitude (or used
   * alone when no altitude column is mapped).
   */
  altitude: number;
}

export const DEFAULT_DECK_VIZ_SCENEGRAPH: DeckVizScenegraphConfig = {
  modelUrl: "",
  sizeScale: 1000,
  sizeMinPixels: 1,
  bearing: 0,
  orientationRoll: 90,
  translation: [0, 0, 0],
  altitude: 0,
};

/** The serialisable description of a built visualization (stored in metadata). */
export interface DeckVizConfig {
  layerKind: string;
  format: DeckVizFormat;
  fieldMapping: DeckVizFieldMapping;
  style: DeckVizStyle;
  /** Present only for the `scenegraph` layer kind. */
  scenegraph?: DeckVizScenegraphConfig;
}

/** Inputs handed to a registry `build` function. */
export interface DeckVizBuildContext {
  /** Parsed rows / tuples / objects (`csv-rows`, `json-array`, `json-objects`). */
  rows?: ReadonlyArray<Record<string, unknown> | ReadonlyArray<unknown>>;
  /** Parsed FeatureCollection (`geojson`). */
  geojson?: FeatureCollection;
  fieldMapping: DeckVizFieldMapping;
  style: DeckVizStyle;
  /** Store layer opacity (0..1), multiplied into the deck layer opacity. */
  opacity: number;
  /** Animation clock for animated layers (same units as the data timestamps). */
  currentTime?: number;
  /** Model URL and transform for the `scenegraph` layer kind. */
  scenegraph?: DeckVizScenegraphConfig;
}

export interface DeckVizExample {
  url: string;
  fieldMapping: DeckVizFieldMapping;
  style?: Partial<DeckVizStyle>;
  /** Default model + transform for the `scenegraph` layer kind. */
  scenegraph?: DeckVizScenegraphConfig;
  /**
   * Default `[lng, lat]` to pre-fill the 3D-model dialog's single-location
   * inputs. Dialog convenience only; placement at render time comes from the
   * row data, so this is not part of the persisted config.
   */
  scenegraphLocation?: [number, number];
}

export interface DeckVizLayerDef {
  kind: string;
  label: string;
  category: DeckVizCategory;
  description: string;
  inputKind: DeckVizInputKind;
  format: DeckVizFormat;
  roles: DeckVizRole[];
  styleControls: DeckVizStyleControl[];
  animated?: boolean;
  build: (deckGL: GeoLibreDeckGL, layerId: string, ctx: DeckVizBuildContext) => Layer;
  example: DeckVizExample;
  /** Largest timestamp in the data, used to size the animation loop. */
  getTimeRange?: (ctx: DeckVizBuildContext) => number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DATA_BASE = "https://raw.githubusercontent.com/visgl/deck.gl-data/master/examples";

// Yellow→red sequential ramp shared by the aggregation layers (matches the
// deck.gl website examples), typed as deck.gl's RGB/RGBA color tuple list.
const COLOR_RANGE: [number, number, number][] = [
  [255, 255, 178],
  [254, 217, 118],
  [254, 178, 76],
  [253, 141, 60],
  [240, 59, 32],
  [189, 0, 38],
];

type AnyRecord = Record<string, unknown> | ReadonlyArray<unknown>;

/** Reads `record[key]` as a number, falling back to 0 for non-finite values. */
function readNumber(record: AnyRecord, key: string | number): number {
  const value = (record as Record<string | number, unknown>)[key];
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Reads `record[key]` as a coordinate, returning NaN (not 0) for
 * missing/invalid values so deck.gl skips the record instead of plotting it at
 * null-island (0°N, 0°E).
 */
function readCoordinate(record: AnyRecord, key: string | number): number {
  const value = (record as Record<string | number, unknown>)[key];
  // Number("") and Number(null) are 0; treat blank/missing cells as invalid
  // (NaN) so deck.gl skips the record instead of plotting it at [0, 0].
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

/** A `[lng, lat]` accessor from two mapped roles. */
function positionAccessor(
  mapping: DeckVizFieldMapping,
  lngRole = "lng",
  latRole = "lat",
): (record: AnyRecord) => [number, number] {
  const lngKey = mapping[lngRole];
  const latKey = mapping[latRole];
  return (record) => [readCoordinate(record, lngKey), readCoordinate(record, latKey)];
}

function rowsOf(ctx: DeckVizBuildContext): AnyRecord[] {
  return (ctx.rows ?? []) as AnyRecord[];
}

function fillColor(style: DeckVizStyle): [number, number, number, number] {
  return colorToRgba(style.color, 1);
}

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------

const LNG_ROLE: DeckVizRole = {
  key: "lng",
  label: "Longitude",
  required: true,
  detect: ["lng", "lon", "long", "longitude", "x"],
};
const LAT_ROLE: DeckVizRole = {
  key: "lat",
  label: "Latitude",
  required: true,
  detect: ["lat", "latitude", "y"],
};
const WEIGHT_ROLE: DeckVizRole = {
  key: "weight",
  label: "Weight (optional)",
  required: false,
  detect: ["weight", "value", "count", "magnitude", "mag"],
};
const SOURCE_LNG_ROLE: DeckVizRole = {
  key: "sourceLng",
  label: "Source longitude",
  required: true,
  detect: ["lon1", "lng1", "source_lng", "from_lng", "origin_lng", "start_lng"],
};
const SOURCE_LAT_ROLE: DeckVizRole = {
  key: "sourceLat",
  label: "Source latitude",
  required: true,
  detect: ["lat1", "source_lat", "from_lat", "origin_lat", "start_lat"],
};
const TARGET_LNG_ROLE: DeckVizRole = {
  key: "targetLng",
  label: "Target longitude",
  required: true,
  detect: ["lon2", "lng2", "target_lng", "to_lng", "dest_lng", "end_lng"],
};
const TARGET_LAT_ROLE: DeckVizRole = {
  key: "targetLat",
  label: "Target latitude",
  required: true,
  detect: ["lat2", "target_lat", "to_lat", "dest_lat", "end_lat"],
};

const ALTITUDE_ROLE: DeckVizRole = {
  key: "altitude",
  label: "Altitude (optional)",
  required: false,
  detect: ["altitude", "alt", "elevation", "height", "z"],
};
const BEARING_ROLE: DeckVizRole = {
  key: "bearing",
  label: "Bearing / heading (optional)",
  required: false,
  detect: ["bearing", "heading", "azimuth", "rotation", "angle", "track"],
};
const SCALE_ROLE: DeckVizRole = {
  key: "scale",
  label: "Scale factor (optional)",
  required: false,
  detect: ["scale", "size"],
};

const POINT_ROLES: DeckVizRole[] = [LNG_ROLE, LAT_ROLE, WEIGHT_ROLE];
const SCENEGRAPH_ROLES: DeckVizRole[] = [
  LNG_ROLE,
  LAT_ROLE,
  ALTITUDE_ROLE,
  BEARING_ROLE,
  SCALE_ROLE,
];
const OD_ROLES: DeckVizRole[] = [
  SOURCE_LNG_ROLE,
  SOURCE_LAT_ROLE,
  TARGET_LNG_ROLE,
  TARGET_LAT_ROLE,
];

function weightAccessor(mapping: DeckVizFieldMapping): ((record: AnyRecord) => number) | undefined {
  if (mapping.weight === undefined || mapping.weight === "") return undefined;
  const key = mapping.weight;
  return (record) => readNumber(record, key);
}

// Cached per data array so the per-frame Trips animation does not rescan every
// row/timestamp; the array identity is stable until the layer's data changes.
const timestampBoundsCache = new WeakMap<object, { min: number; max: number }>();

/** Min/max of all timestamp values across the mapped `timestamps` arrays. */
function timestampBounds(ctx: DeckVizBuildContext): { min: number; max: number } {
  const rows = ctx.rows;
  if (rows) {
    const cached = timestampBoundsCache.get(rows);
    if (cached) return cached;
  }
  const tsKey = ctx.fieldMapping.timestamps;
  let min = Infinity;
  let max = -Infinity;
  for (const record of rowsOf(ctx)) {
    const stamps = (record as Record<string | number, unknown>)[tsKey];
    if (!Array.isArray(stamps)) continue;
    for (const value of stamps) {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      if (num < min) min = num;
      if (num > max) max = num;
    }
  }
  const result = min === Infinity ? { min: 0, max: 0 } : { min, max };
  if (rows) timestampBoundsCache.set(rows, result);
  return result;
}

const DEFINITIONS: DeckVizLayerDef[] = [
  // ---- Point & aggregation -------------------------------------------------
  {
    kind: "scatterplot",
    label: "Scatterplot",
    category: "point",
    description: "Circles at each point. CSV/JSON with longitude & latitude.",
    inputKind: "json-array",
    format: "json-array",
    roles: POINT_ROLES,
    styleControls: ["color", "radius"],
    build: (deckGL, id, ctx) =>
      new deckGL.layers.ScatterplotLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        getRadius: ctx.style.radius,
        getFillColor: fillColor(ctx.style),
        radiusUnits: "meters",
        radiusMinPixels: 1,
        radiusMaxPixels: 100,
        opacity: ctx.opacity,
        pickable: true,
      }),
    example: {
      url: `${DATA_BASE}/scatterplot/manhattan.json`,
      fieldMapping: { lng: 0, lat: 1 },
      style: { radius: 20 },
    },
  },
  {
    kind: "heatmap",
    label: "Heatmap",
    category: "point",
    description: "Smooth density heatmap from weighted points.",
    inputKind: "json-array",
    format: "json-array",
    roles: POINT_ROLES,
    styleControls: ["radius"],
    build: (deckGL, id, ctx) => {
      const weight = weightAccessor(ctx.fieldMapping);
      return new deckGL.aggregationLayers.HeatmapLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        ...(weight ? { getWeight: weight } : {}),
        radiusPixels: Math.max(ctx.style.radius, 10),
        colorRange: COLOR_RANGE,
        opacity: ctx.opacity,
      });
    },
    example: {
      url: `${DATA_BASE}/screen-grid/uber-pickup-locations.json`,
      fieldMapping: { lng: 0, lat: 1, weight: 2 },
      style: { radius: 30 },
    },
  },
  {
    kind: "hexagon",
    label: "Hexagon (3D)",
    category: "point",
    description: "Aggregates points into extruded hexagonal bins.",
    inputKind: "point-csv",
    format: "csv-rows",
    roles: POINT_ROLES,
    styleControls: ["cellSize", "extruded"],
    build: (deckGL, id, ctx) => {
      const weight = weightAccessor(ctx.fieldMapping);
      return new deckGL.aggregationLayers.HexagonLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        // Omit the weight accessors with no weight column so deck.gl uses its
        // count-based default; a constant accessor breaks GPU aggregation.
        ...(weight ? { getColorWeight: weight, getElevationWeight: weight } : {}),
        radius: ctx.style.cellSize,
        extruded: ctx.style.extruded,
        elevationScale: ctx.style.extruded ? ctx.style.elevationScale : 0,
        colorRange: COLOR_RANGE,
        opacity: ctx.opacity,
        pickable: true,
      });
    },
    example: {
      url: `${DATA_BASE}/3d-heatmap/heatmap-data.csv`,
      fieldMapping: { lng: "lng", lat: "lat" },
      style: { cellSize: 6000, extruded: true, elevationScale: 50 },
    },
  },
  {
    kind: "grid",
    label: "Grid (3D)",
    category: "point",
    description: "Aggregates points into extruded square bins.",
    inputKind: "point-csv",
    format: "csv-rows",
    roles: POINT_ROLES,
    styleControls: ["cellSize", "extruded"],
    build: (deckGL, id, ctx) => {
      const weight = weightAccessor(ctx.fieldMapping);
      return new deckGL.aggregationLayers.GridLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        ...(weight ? { getColorWeight: weight, getElevationWeight: weight } : {}),
        cellSize: ctx.style.cellSize,
        extruded: ctx.style.extruded,
        elevationScale: ctx.style.extruded ? ctx.style.elevationScale : 0,
        colorRange: COLOR_RANGE,
        opacity: ctx.opacity,
        pickable: true,
      });
    },
    example: {
      url: `${DATA_BASE}/3d-heatmap/heatmap-data.csv`,
      fieldMapping: { lng: "lng", lat: "lat" },
      style: { cellSize: 6000, extruded: true, elevationScale: 50 },
    },
  },
  {
    kind: "screen-grid",
    label: "Screen grid",
    category: "point",
    description: "Aggregates points into fixed-pixel screen cells.",
    inputKind: "json-array",
    format: "json-array",
    roles: POINT_ROLES,
    styleControls: ["cellSize"],
    build: (deckGL, id, ctx) => {
      const weight = weightAccessor(ctx.fieldMapping);
      return new deckGL.aggregationLayers.ScreenGridLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        ...(weight ? { getWeight: weight } : {}),
        cellSizePixels: Math.max(Math.round(ctx.style.cellSize), 5),
        colorRange: COLOR_RANGE,
        opacity: ctx.opacity,
      });
    },
    example: {
      url: `${DATA_BASE}/screen-grid/uber-pickup-locations.json`,
      fieldMapping: { lng: 0, lat: 1, weight: 2 },
      style: { cellSize: 20 },
    },
  },
  {
    kind: "contour",
    label: "Contour",
    category: "point",
    description: "Isoline bands over point density.",
    inputKind: "point-csv",
    format: "csv-rows",
    roles: POINT_ROLES,
    styleControls: ["cellSize"],
    build: (deckGL, id, ctx) => {
      const weight = weightAccessor(ctx.fieldMapping);
      return new deckGL.aggregationLayers.ContourLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        ...(weight ? { getWeight: weight } : {}),
        cellSize: ctx.style.cellSize,
        contours: [
          { threshold: 1, color: [255, 255, 178], strokeWidth: 2 },
          { threshold: 5, color: [253, 141, 60], strokeWidth: 3 },
          { threshold: 15, color: [189, 0, 38], strokeWidth: 4 },
        ],
        opacity: ctx.opacity,
      });
    },
    example: {
      url: `${DATA_BASE}/3d-heatmap/heatmap-data.csv`,
      fieldMapping: { lng: "lng", lat: "lat" },
      style: { cellSize: 4000 },
    },
  },
  // ---- Flow / OD -----------------------------------------------------------
  {
    kind: "arc",
    label: "Arc",
    category: "flow",
    description: "Curved arcs between source and target points.",
    inputKind: "od-csv",
    format: "csv-rows",
    roles: OD_ROLES,
    styleControls: ["color", "lineWidth"],
    build: (deckGL, id, ctx) =>
      new deckGL.layers.ArcLayer({
        id,
        data: rowsOf(ctx),
        getSourcePosition: positionAccessor(ctx.fieldMapping, "sourceLng", "sourceLat"),
        getTargetPosition: positionAccessor(ctx.fieldMapping, "targetLng", "targetLat"),
        getSourceColor: fillColor(ctx.style),
        getTargetColor: colorToRgba(ctx.style.color, 0.4),
        getWidth: ctx.style.lineWidth,
        opacity: ctx.opacity,
        pickable: true,
      }),
    example: {
      url: `${DATA_BASE}/globe/2020-01-14.csv`,
      fieldMapping: {
        sourceLng: "lon1",
        sourceLat: "lat1",
        targetLng: "lon2",
        targetLat: "lat2",
      },
      style: { lineWidth: 1 },
    },
  },
  {
    kind: "line",
    label: "Line",
    category: "flow",
    description: "Straight lines between source and target points.",
    inputKind: "od-csv",
    format: "csv-rows",
    roles: OD_ROLES,
    styleControls: ["color", "lineWidth"],
    build: (deckGL, id, ctx) =>
      new deckGL.layers.LineLayer({
        id,
        data: rowsOf(ctx),
        getSourcePosition: positionAccessor(ctx.fieldMapping, "sourceLng", "sourceLat"),
        getTargetPosition: positionAccessor(ctx.fieldMapping, "targetLng", "targetLat"),
        getColor: fillColor(ctx.style),
        getWidth: ctx.style.lineWidth,
        opacity: ctx.opacity,
        pickable: true,
      }),
    example: {
      url: `${DATA_BASE}/globe/2020-01-14.csv`,
      fieldMapping: {
        sourceLng: "lon1",
        sourceLat: "lat1",
        targetLng: "lon2",
        targetLat: "lat2",
      },
      style: { lineWidth: 2 },
    },
  },
  {
    kind: "great-circle",
    label: "Great circle",
    category: "flow",
    description: "Geodesic great-circle paths between points.",
    inputKind: "od-csv",
    format: "csv-rows",
    roles: OD_ROLES,
    styleControls: ["color", "lineWidth"],
    build: (deckGL, id, ctx) =>
      new deckGL.geoLayers.GreatCircleLayer({
        id,
        data: rowsOf(ctx),
        getSourcePosition: positionAccessor(ctx.fieldMapping, "sourceLng", "sourceLat"),
        getTargetPosition: positionAccessor(ctx.fieldMapping, "targetLng", "targetLat"),
        getSourceColor: fillColor(ctx.style),
        getTargetColor: colorToRgba(ctx.style.color, 0.4),
        getWidth: ctx.style.lineWidth,
        opacity: ctx.opacity,
        pickable: true,
      }),
    example: {
      url: `${DATA_BASE}/globe/2020-01-14.csv`,
      fieldMapping: {
        sourceLng: "lon1",
        sourceLat: "lat1",
        targetLng: "lon2",
        targetLat: "lat2",
      },
      style: { lineWidth: 2 },
    },
  },
  // ---- GeoJSON -------------------------------------------------------------
  {
    kind: "geojson",
    label: "GeoJSON (with extrusion)",
    category: "geojson",
    description: "Render a GeoJSON file; optionally extrude polygons by a property.",
    inputKind: "geojson",
    format: "geojson",
    roles: [
      {
        key: "elevation",
        label: "Extrusion height property (optional)",
        required: false,
        detect: ["height", "elevation", "value", "valuepersqm"],
      },
    ],
    styleControls: ["color", "extruded"],
    build: (deckGL, id, ctx) => {
      const elevationKey = ctx.fieldMapping.elevation;
      const extruded = ctx.style.extruded && elevationKey !== undefined;
      return new deckGL.layers.GeoJsonLayer({
        id,
        data: (ctx.geojson ?? {
          type: "FeatureCollection",
          features: [],
        }) as FeatureCollection,
        filled: true,
        stroked: true,
        extruded,
        getFillColor: colorToRgba(ctx.style.color, 0.7),
        getLineColor: colorToRgba(ctx.style.color, 1),
        getLineWidth: ctx.style.lineWidth,
        lineWidthMinPixels: 1,
        getPointRadius: ctx.style.radius,
        pointRadiusUnits: "meters",
        pointRadiusMinPixels: 2,
        getElevation: extruded
          ? (feature: { properties?: Record<string, unknown> | null }) =>
              readNumber(
                (feature.properties ?? {}) as Record<string, unknown>,
                elevationKey as string,
              )
          : 0,
        opacity: ctx.opacity,
        pickable: true,
      });
    },
    example: {
      url: `${DATA_BASE}/geojson/vancouver-blocks.json`,
      fieldMapping: { elevation: "valuePerSqm" },
      style: { extruded: true },
    },
  },
  // ---- Advanced / animated -------------------------------------------------
  {
    kind: "icon",
    label: "Icon markers",
    category: "advanced",
    description: "A marker icon at each point. CSV/JSON with longitude & latitude.",
    inputKind: "point-csv",
    format: "csv-rows",
    roles: [LNG_ROLE, LAT_ROLE],
    styleControls: ["color", "radius"],
    build: (deckGL, id, ctx) =>
      new deckGL.layers.IconLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        getIcon: () => "marker",
        iconAtlas:
          "https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/icon-atlas.png",
        iconMapping: {
          marker: { x: 0, y: 0, width: 128, height: 128, mask: true, anchorY: 128 },
        },
        getColor: fillColor(ctx.style),
        getSize: Math.max(ctx.style.radius, 12),
        sizeUnits: "pixels",
        pickable: true,
        opacity: ctx.opacity,
      }),
    example: {
      url: `${DATA_BASE}/text-layer/cities-1000.csv`,
      fieldMapping: { lng: "longitude", lat: "latitude" },
      style: { radius: 24 },
    },
  },
  {
    kind: "text",
    label: "Text labels",
    category: "advanced",
    description: "A text label at each point. CSV/JSON with a label column.",
    inputKind: "point-csv",
    format: "csv-rows",
    roles: [
      LNG_ROLE,
      LAT_ROLE,
      {
        key: "text",
        label: "Label text",
        required: true,
        detect: ["name", "label", "text", "title"],
      },
    ],
    styleControls: ["color"],
    build: (deckGL, id, ctx) => {
      const textKey = ctx.fieldMapping.text;
      return new deckGL.layers.TextLayer({
        id,
        data: rowsOf(ctx),
        getPosition: positionAccessor(ctx.fieldMapping),
        getText: (record: AnyRecord) =>
          String((record as Record<string | number, unknown>)[textKey] ?? ""),
        getColor: fillColor(ctx.style),
        getSize: 16,
        sizeUnits: "pixels",
        background: true,
        getBackgroundColor: [255, 255, 255, 200],
        pickable: true,
        opacity: ctx.opacity,
      });
    },
    example: {
      url: `${DATA_BASE}/text-layer/cities-1000.csv`,
      fieldMapping: { lng: "longitude", lat: "latitude", text: "name" },
    },
  },
  {
    kind: "trips",
    label: "Trips (animated)",
    category: "advanced",
    description: "Animated trails along paths. JSON array of objects with path & timestamps.",
    inputKind: "json-objects",
    format: "json-objects",
    roles: [
      {
        key: "path",
        label: "Path property",
        required: true,
        detect: ["path", "coordinates", "geometry"],
      },
      {
        key: "timestamps",
        label: "Timestamps property",
        required: true,
        detect: ["timestamps", "time", "times"],
      },
    ],
    styleControls: ["color", "lineWidth"],
    animated: true,
    build: (deckGL, id, ctx) => {
      const pathKey = ctx.fieldMapping.path;
      const tsKey = ctx.fieldMapping.timestamps;
      // Normalise timestamps to start at 0 so the loop (which runs from 0)
      // works for data whose timestamps begin far above 0.
      const { min: minTs } = timestampBounds(ctx);
      return new deckGL.geoLayers.TripsLayer({
        id,
        data: rowsOf(ctx),
        // deck.gl types PathGeometry as a flat number[], but PathLayer accepts
        // the nested [[lng,lat],...] arrays our data uses; cast to satisfy it.
        getPath: (record: AnyRecord) =>
          (record as Record<string | number, unknown>)[pathKey] as unknown as number[],
        getTimestamps: (record: AnyRecord) => {
          const stamps = (record as Record<string | number, unknown>)[tsKey];
          return Array.isArray(stamps) ? stamps.map((value) => Number(value) - minTs) : [];
        },
        getColor: fillColor(ctx.style),
        widthMinPixels: Math.max(ctx.style.lineWidth, 1),
        rounded: true,
        trailLength: 180,
        currentTime: ctx.currentTime ?? 0,
        opacity: ctx.opacity,
      });
    },
    getTimeRange: (ctx) => {
      const { min, max } = timestampBounds(ctx);
      return max - min;
    },
    example: {
      url: `${DATA_BASE}/trips/trips-v7.json`,
      fieldMapping: { path: "path", timestamps: "timestamps" },
      style: { lineWidth: 2, color: "#f97316" },
    },
  },
  // ---- 3D models -----------------------------------------------------------
  {
    kind: "scenegraph",
    label: "3D model (glTF)",
    category: "models",
    description:
      "Place a glTF/GLB 3D model at each point. CSV/JSON with longitude & latitude, plus a model URL.",
    inputKind: "point-csv",
    format: "csv-rows",
    roles: SCENEGRAPH_ROLES,
    styleControls: [],
    build: (deckGL, id, ctx) => {
      const sg = ctx.scenegraph ?? DEFAULT_DECK_VIZ_SCENEGRAPH;
      const mapping = ctx.fieldMapping;
      const position = positionAccessor(mapping);
      const altKey = mapping.altitude;
      const bearingKey = mapping.bearing;
      const scaleKey = mapping.scale;
      const hasAlt = altKey !== undefined && altKey !== "";
      const hasBearing = bearingKey !== undefined && bearingKey !== "";
      const hasScale = scaleKey !== undefined && scaleKey !== "";
      // ScenegraphLayer needs a model; with no URL there is nothing to render,
      // so emit an empty layer rather than throwing (keeps the overlay alive).
      const data = sg.modelUrl ? rowsOf(ctx) : [];
      return new deckGL.meshLayers.ScenegraphLayer({
        id,
        data,
        scenegraph: sg.modelUrl,
        _lighting: "pbr",
        sizeScale: sg.sizeScale,
        // Floor the on-screen size so distant models stay visible; leave the
        // ceiling unset so zooming in scales the model up naturally instead of
        // clamping a single large asset (building, turbine) to a small dot.
        sizeMinPixels: sg.sizeMinPixels ?? DEFAULT_DECK_VIZ_SCENEGRAPH.sizeMinPixels ?? 1,
        getPosition: (record: AnyRecord) => {
          const [lng, lat] = position(record);
          const altitude = (hasAlt ? readNumber(record, altKey) : 0) + sg.altitude;
          return [lng, lat, altitude];
        },
        // glTF models are Y-up; the trailing 90° roll stands them upright in
        // deck.gl's Z-up frame (matching deck.gl's ScenegraphLayer examples).
        getOrientation: (record: AnyRecord): [number, number, number] => [
          0,
          hasBearing ? readNumber(record, bearingKey) : sg.bearing,
          sg.orientationRoll ?? DEFAULT_DECK_VIZ_SCENEGRAPH.orientationRoll ?? 90,
        ],
        getTranslation: sg.translation ?? DEFAULT_DECK_VIZ_SCENEGRAPH.translation ?? [0, 0, 0],
        ...(hasScale
          ? {
              getScale: (record: AnyRecord): [number, number, number] => {
                const s = readNumber(record, scaleKey) || 1;
                return [s, s, s];
              },
            }
          : {}),
        opacity: ctx.opacity,
        pickable: true,
      });
    },
    example: {
      url: `${DATA_BASE}/text-layer/cities-1000.csv`,
      fieldMapping: { lng: "longitude", lat: "latitude" },
      scenegraph: {
        // Pinned to a commit SHA (not `master`) so the bundled example does
        // not silently break if the asset is moved/renamed upstream.
        modelUrl: `https://raw.githubusercontent.com/visgl/deck.gl-data/1d1f1f2a8de2d2ff5a3f55cb4763171253cc2738/examples/scenegraph-layer/airplane.glb`,
        sizeScale: 3000,
        bearing: 0,
        altitude: 0,
      },
      // San Francisco International Airport — a fitting spot for the airplane
      // model in single-location mode.
      scenegraphLocation: [-122.379, 37.6213],
    },
  },
];

const REGISTRY = new Map<string, DeckVizLayerDef>(DEFINITIONS.map((def) => [def.kind, def]));

/** All layer definitions, in registration (display) order. */
export function listDeckVizLayerDefs(): DeckVizLayerDef[] {
  return DEFINITIONS;
}

/** Look up a layer definition by its registry kind. */
export function getDeckVizLayerDef(kind: string): DeckVizLayerDef | undefined {
  return REGISTRY.get(kind);
}

/** Human-readable category labels for the picker, in display order. */
export const DECK_VIZ_CATEGORY_LABELS: Record<DeckVizCategory, string> = {
  point: "Point & aggregation",
  flow: "Flow / origin-destination",
  geojson: "GeoJSON",
  advanced: "Advanced / animated",
  models: "3D models",
};
