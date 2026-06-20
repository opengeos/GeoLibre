import type { FeatureCollection } from "geojson";

export const OPENFREEMAP_BASEMAPS = [
  {
    id: "liberty",
    name: "Liberty",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  },
  {
    id: "liberty-3d",
    name: "Liberty 3D",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  },
  {
    id: "positron",
    name: "Positron",
    styleUrl: "https://tiles.openfreemap.org/styles/positron",
  },
  {
    id: "bright",
    name: "Bright",
    styleUrl: "https://tiles.openfreemap.org/styles/bright",
  },
  {
    id: "dark",
    name: "Dark",
    styleUrl: "https://tiles.openfreemap.org/styles/dark",
  },
  {
    id: "fiord",
    name: "Fiord",
    styleUrl: "https://tiles.openfreemap.org/styles/fiord",
  },
] as const;

/**
 * Protomaps v5 basemap flavors. These are resolved to full style URLs at use
 * time by `getProtomapsStyleUrl`, which injects the `VITE_PROTOMAPS_API_KEY`
 * runtime env var. The key is only present in builds configured with it (e.g.
 * the GitHub Pages web demo), so consumers should hide these options when no
 * key is available.
 */
export const PROTOMAPS_BASEMAPS = [
  { id: "protomaps-light", name: "Light", flavor: "light" },
  { id: "protomaps-dark", name: "Dark", flavor: "dark" },
  { id: "protomaps-white", name: "White", flavor: "white" },
  { id: "protomaps-grayscale", name: "Grayscale", flavor: "grayscale" },
  { id: "protomaps-black", name: "Black", flavor: "black" },
] as const;

export const DEFAULT_BASEMAP = "https://tiles.openfreemap.org/styles/liberty";

export const BLANK_BASEMAP = "";

export const PROJECT_VERSION = "0.2.0";

export type LayerType =
  | "geojson"
  | "raster"
  | "wms"
  | "wmts"
  | "xyz"
  | "vector-tiles"
  | "arcgis"
  | "pmtiles"
  | "mbtiles"
  | "zarr"
  | "lidar"
  | "gaussian-splat"
  | "3d-tiles"
  | "cog"
  | "flatgeobuf"
  | "geoparquet"
  | "duckdb-query"
  | "deckgl-viz"
  | "video"
  | "image";

export type VectorStyleMode =
  | "single"
  | "graduated"
  | "categorized"
  | "rule-based"
  | "expression";

/**
 * One entry in a {@link LayerStyle.vectorRules} rule-based renderer. Each rule
 * pairs a MapLibre filter expression (a boolean expression array, serialized as
 * JSON) with a symbol color. Rules are evaluated top to bottom; the first whose
 * filter matches wins. The catch-all rule (`isElse`) has no filter and supplies
 * the color for features no other rule matched. Mirrors the QGIS/ArcGIS
 * rule-based renderer.
 */
export interface VectorRule {
  id: string;
  /** Human-readable label shown in the editor and the legend. */
  label: string;
  /**
   * A MapLibre boolean filter expression serialized as JSON, e.g.
   * `["==", ["get", "TYPE"], "park"]`. Ignored when {@link isElse} is set or
   * the JSON is invalid.
   */
  filter: string;
  /** The symbol fill/circle color for features this rule matches (6-digit hex). */
  color: string;
  /** When true this is the catch-all "else" rule and {@link filter} is unused. */
  isElse: boolean;
}

/**
 * The fill pattern applied to polygon layers. `"none"` keeps a flat fill; the
 * named patterns are generated as recolorable sprite tiles; `"svg"` rasterizes
 * the user-supplied markup in {@link LayerStyle.fillPatternSvg}.
 */
export type FillPattern =
  | "none"
  | "hatch"
  | "cross-hatch"
  | "horizontal"
  | "vertical"
  | "dots"
  | "svg";

/**
 * The built-in marker shape for a point layer, or `"custom"` to rasterize the
 * user-supplied SVG in {@link LayerStyle.markerSvg}. Built-in shapes are drawn
 * on a sprite tile and recolored via {@link LayerStyle.markerColor}.
 */
export type MarkerShape =
  | "circle"
  | "square"
  | "triangle"
  | "diamond"
  | "star"
  | "cross"
  | "pin"
  | "custom";

/**
 * How a point layer is rendered: as individual markers, a density heatmap, or
 * clustered bubbles. Only applies to point geometry.
 */
export type PointRenderer = "single" | "heatmap" | "cluster";

/**
 * Unit a stroke/line width is measured in. `"pixels"` is constant screen space;
 * `"meters"` is ground distance, so the rendered width scales with the map
 * scale (zoom). See {@link LayerStyle.strokeWidthUnit}.
 */
export type StrokeWidthUnit = "pixels" | "meters";

export interface VectorStyleStop {
  value: string | number;
  color: string;
  label?: string;
}

/** Attribute-driven labeling for a vector layer (rendered as a MapLibre symbol layer). */
export interface LabelStyle {
  /** Whether labels are shown for the layer. */
  enabled: boolean;
  /** Attribute field whose value becomes the label text. */
  field: string;
  /**
   * Optional MapLibre expression (JSON string) for the label text, which
   * overrides {@link field} when non-empty (e.g. concatenating several fields).
   */
  expression: string;
  /** `"point"` labels at the feature/centroid; `"line"` places them along lines. */
  placement: "point" | "line";
  /** Label text size in pixels. */
  size: number;
  /** CSS color string for the label text. */
  color: string;
  /** CSS color string for the text halo drawn behind the label. */
  haloColor: string;
  /** Width of the text halo in pixels. */
  haloWidth: number;
  /** Scale range for labels; `0` / `24` inherit the layer's own zoom range. */
  minZoom: number;
  maxZoom: number;
  /** Let labels overlap instead of hiding colliding ones. */
  allowOverlap: boolean;
}

export interface LayerStyle {
  minZoom: number;
  maxZoom: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  /**
   * Unit the {@link strokeWidth} value is expressed in.
   *
   * - `"pixels"` (default): a constant screen-space width that never changes
   *   with zoom — the historical behavior.
   * - `"meters"`: a ground-distance width, so the rendered line stays
   *   proportional to the map scale (thicker zoomed in, thinner zoomed out),
   *   matching QGIS "map units". Only affects line/polygon-outline rendering;
   *   point/circle outlines remain pixel-based.
   */
  strokeWidthUnit: StrokeWidthUnit;
  fillOpacity: number;
  circleRadius: number;
  textColor: string;
  textHaloColor: string;
  textHaloWidth: number;
  textSize: number;
  labels: LabelStyle;
  extrusionEnabled: boolean;
  extrusionColor: string;
  extrusionOpacity: number;
  extrusionHeightProperty: string;
  extrusionHeightScale: number;
  extrusionBase: number;
  extrusionAdvancedStyleEnabled: boolean;
  extrusionColorExpression: string;
  extrusionHeightExpression: string;
  vectorStyleMode: VectorStyleMode;
  vectorStyleProperty: string;
  vectorStyleClassCount: number;
  vectorStyleColorRamp: string;
  vectorStyleClassificationScheme: string;
  vectorStyleStops: VectorStyleStop[];
  vectorStyleExpression: string;
  /**
   * Ordered rules for the `"rule-based"` {@link vectorStyleMode}. Compiled to a
   * MapLibre `case` color expression (first matching filter wins, catch-all
   * last). See {@link VectorRule}.
   */
  vectorRules: VectorRule[];
  /**
   * When true, the point circle radius (or line width) is sized by a numeric
   * field via an `interpolate` between {@link proportionalSizeMinValue} ..
   * {@link proportionalSizeMaxValue} mapped onto {@link proportionalSizeMinRadius}
   * .. {@link proportionalSizeMaxRadius} (QGIS "graduated → size" / proportional
   * symbols). Orthogonal to the color {@link vectorStyleMode}.
   */
  proportionalSizeEnabled: boolean;
  proportionalSizeProperty: string;
  proportionalSizeMinValue: number;
  proportionalSizeMaxValue: number;
  proportionalSizeMinRadius: number;
  proportionalSizeMaxRadius: number;
  /**
   * Polygon fill pattern. `"none"` keeps the flat fill; other values render a
   * recolorable sprite tile ({@link fillPatternColor}); `"svg"` rasterizes
   * {@link fillPatternSvg}. See {@link FillPattern}.
   */
  fillPattern: FillPattern;
  fillPatternColor: string;
  /** Raw SVG markup (or a data URL) used when {@link fillPattern} is `"svg"`. */
  fillPatternSvg: string;
  /**
   * When true, point features render as a marker icon ({@link markerShape})
   * instead of a plain circle. Built-in shapes are recolored via
   * {@link markerColor}; `"custom"` rasterizes {@link markerSvg}.
   */
  markerEnabled: boolean;
  markerShape: MarkerShape;
  markerColor: string;
  markerSize: number;
  /** Raw SVG markup (or a data URL) used when {@link markerShape} is `"custom"`. */
  markerSvg: string;
  /**
   * When true, per-feature [simplestyle-spec](https://github.com/mapbox/simplestyle-spec)
   * properties (`fill`, `fill-opacity`, `stroke`, `stroke-width`,
   * `stroke-opacity`, `marker-color`) override the flat layer style on a
   * per-feature basis. Set automatically when a GeoJSON layer is added whose
   * features carry these properties (e.g. styled KML/KMZ), so embedded
   * symbology renders without manual configuration.
   */
  simpleStyleEnabled: boolean;
  pointRenderer: PointRenderer;
  heatmapRadius: number;
  heatmapIntensity: number;
  clusterRadius: number;
  clusterMaxZoom: number;
  rasterBrightnessMin: number;
  rasterBrightnessMax: number;
  rasterSaturation: number;
  rasterContrast: number;
  rasterHueRotate: number;
}

export const DEFAULT_LAYER_STYLE: LayerStyle = {
  minZoom: 0,
  maxZoom: 24,
  fillColor: "#3b82f6",
  strokeColor: "#1e40af",
  strokeWidth: 2,
  strokeWidthUnit: "pixels",
  fillOpacity: 0.6,
  circleRadius: 6,
  textColor: "#111827",
  textHaloColor: "#ffffff",
  textHaloWidth: 2,
  textSize: 16,
  labels: {
    enabled: false,
    field: "",
    expression: "",
    placement: "point",
    size: 13,
    color: "#111827",
    haloColor: "#ffffff",
    haloWidth: 1.5,
    minZoom: 0,
    maxZoom: 24,
    allowOverlap: false,
  },
  extrusionEnabled: false,
  extrusionColor: "#3b82f6",
  extrusionOpacity: 0.8,
  extrusionHeightProperty: "height",
  extrusionHeightScale: 1,
  extrusionBase: 0,
  extrusionAdvancedStyleEnabled: false,
  extrusionColorExpression: "",
  extrusionHeightExpression: "",
  vectorStyleMode: "single",
  vectorStyleProperty: "",
  vectorStyleClassCount: 5,
  vectorStyleColorRamp: "viridis",
  vectorStyleClassificationScheme: "equal-interval",
  vectorStyleStops: [
    { value: 0, color: "#dbeafe" },
    { value: 1, color: "#2563eb" },
  ],
  vectorStyleExpression: "",
  vectorRules: [],
  proportionalSizeEnabled: false,
  proportionalSizeProperty: "",
  proportionalSizeMinValue: 0,
  proportionalSizeMaxValue: 100,
  proportionalSizeMinRadius: 4,
  proportionalSizeMaxRadius: 24,
  fillPattern: "none",
  fillPatternColor: "#1e40af",
  fillPatternSvg: "",
  markerEnabled: false,
  markerShape: "circle",
  markerColor: "#3b82f6",
  markerSize: 18,
  markerSvg: "",
  simpleStyleEnabled: false,
  pointRenderer: "single",
  heatmapRadius: 30,
  heatmapIntensity: 1,
  clusterRadius: 50,
  clusterMaxZoom: 14,
  rasterBrightnessMin: 0,
  rasterBrightnessMax: 1,
  rasterSaturation: 0,
  rasterContrast: 0,
  rasterHueRotate: 0,
};

/**
 * Read a layer style property, falling back to the shared default when the
 * layer does not define it. Shared by `@geolibre/map` and the desktop app so
 * the two consumers cannot drift.
 */
export function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

/**
 * Feature-count threshold above which a local vector (GeoJSON) layer is rendered
 * through client-side vector tiles (geojson-vt / supercluster served by a custom
 * MapLibre protocol) instead of one in-memory geojson source pushed via
 * `setData`. Small layers stay on the simpler inline path. Mirrors the
 * `MAX_CEREUS_FEATURES` precedent in the desktop SQL engine.
 */
export const LARGE_VECTOR_FEATURE_THRESHOLD = 50_000;

/**
 * Decide whether a GeoJSON layer should use the tiled rendering path.
 *
 * @param geojson - The layer's feature collection (may be undefined for
 *   non-vector layers).
 * @returns `true` when the collection exceeds
 *   {@link LARGE_VECTOR_FEATURE_THRESHOLD} features.
 */
export function shouldUseTiledRendering(
  geojson: GeoJSON.FeatureCollection | undefined,
): boolean {
  return (
    (geojson?.features.length ?? 0) > LARGE_VECTOR_FEATURE_THRESHOLD
  );
}

export interface GeoLibreLayer {
  id: string;
  name: string;
  type: LayerType;
  source: Record<string, unknown>;
  visible: boolean;
  opacity: number;
  style: LayerStyle;
  metadata: Record<string, unknown>;
  beforeId?: string;
  geojson?: FeatureCollection;
  /**
   * Transient MapLibre filter expression applied on top of every rendered
   * sub-layer's geometry filter. The Time Slider plugin sets this on a bound
   * vector layer so scrubbing the timeline narrows the visible features to the
   * current time window, while the layer's own styling and opacity stay
   * untouched. It is derived from the slider's current date, so it is NOT
   * persisted (stripped by `prepareLayerForSave`); the binding config lives in
   * `metadata.timeBinding` and the filter is recomputed live on the next
   * activation. `undefined` means no time filter is applied.
   */
  timeFilter?: unknown[];
  sourcePath?: string;
  /**
   * Id of the {@link LayerGroup} this layer belongs to, or `undefined` when the
   * layer sits at the top level of the layer panel. Layers sharing a `groupId`
   * are kept contiguous in the store's flat `layers` array so the group renders
   * as one block; see `@geolibre/core`'s `layer-groups` helpers.
   */
  groupId?: string;
}

/**
 * A named, collapsible folder in the layer panel that organizes a contiguous
 * run of layers (single-level nesting; groups never contain other groups).
 *
 * The group's `visible` flag and `opacity` multiplier are folded into each
 * child layer's effective render state by `applyGroupEffects` before the map
 * syncs, so children keep their own stored `visible`/`opacity` values.
 */
export interface LayerGroup {
  id: string;
  name: string;
  /** When true, the group's children are hidden in the panel (not on the map). */
  collapsed: boolean;
  /** Group-level visibility; ANDed with each child layer's own visibility. */
  visible: boolean;
  /** Group-level opacity in [0, 1]; multiplied into each child's opacity. */
  opacity: number;
}

/**
 * Detect a DuckDB query layer rendered through the plugin's external deck.gl
 * overlay. Shared by `@geolibre/map`, `@geolibre/plugins`, and the desktop
 * app so the detection criteria cannot drift.
 */
export function isDuckDBQueryLayer(
  layer: Pick<GeoLibreLayer, "metadata" | "type"> | undefined,
): boolean {
  return (
    layer?.type === "duckdb-query" &&
    layer.metadata.sourceKind === "duckdb-query" &&
    layer.metadata.externalDeckLayer === true
  );
}

export interface MapViewState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bbox?: [number, number, number, number];
}

/**
 * Live multi-user collaboration (issue #307). These types describe the
 * *ephemeral* session state the store holds while a live session is active. It
 * is intentionally never written to the `.geolibre.json` project file (the
 * `project.ts` serializers never read it) and never tracked in undo history (the
 * store's `partialize` never lists it), so it resets cleanly on reload.
 */
export type CollaborationRole = "host" | "guest";

/** Whether guests may edit (`co-edit`) or only watch (`view-only`). */
export type CollaborationMode = "view-only" | "co-edit";

export interface CollaborationParticipant {
  clientId: string;
  displayName: string;
  color: string;
  role: CollaborationRole;
}

/** A remote participant's live cursor + viewport, used to render presence. */
export interface CollaborationPresence {
  displayName: string;
  color: string;
  cursor?: { lng: number; lat: number } | null;
  view?: MapViewState | null;
}

export interface CollaborationState {
  /** True once connected and joined to a session. */
  isActive: boolean;
  /** True while connecting/reconnecting (UI shows a spinner). */
  connecting: boolean;
  sessionId: string | null;
  clientId: string | null;
  role: CollaborationRole | null;
  mode: CollaborationMode;
  selfName: string;
  selfColor: string;
  participants: CollaborationParticipant[];
  /** Remote presence keyed by participant clientId (never includes self). */
  presence: Record<string, CollaborationPresence>;
  /** When true, this participant's camera follows the host's viewport. */
  followHost: boolean;
  /** Last human-readable error, surfaced in the Collaborate dialog. */
  error: string | null;
}

/** Map projection the renderer uses. Mirrors the GlobeControl toggle. */
export type MapProjection = "globe" | "mercator";

export interface MapPreferences {
  restrictBounds: boolean;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  maxPitch: number;
  renderWorldCopies: boolean;
  projection: MapProjection;
}

export interface RuntimeEnvironmentVariable {
  key: string;
  value: string;
  enabled: boolean;
}

declare global {
  interface Window {
    // Runtime environment variables published from project preferences. Shared
    // here so the desktop app and plugins type the global from one source.
    __GEOLIBRE_RUNTIME_ENV__?: Record<string, string>;
  }
}

/**
 * Geocoding backend selection persisted in the project. The provider id keys
 * into the geocoding registry in `@geolibre/core`; API keys are stored per
 * provider so switching backends does not discard the others' keys. Empty
 * endpoint overrides fall back to the provider's default endpoints.
 */
export interface GeocodingPreferences {
  providerId: string;
  /** Per-provider API key / access token, keyed by provider id. */
  apiKeys: Record<string, string>;
  /** Optional custom forward endpoint (else the provider default). */
  forwardEndpoint?: string;
  /** Optional custom reverse endpoint (else the provider default). */
  reverseEndpoint?: string;
  /** Contact email sent to identify the client (used by Nominatim). */
  email?: string;
}

export interface ProjectPreferences {
  map: MapPreferences;
  environmentVariables: RuntimeEnvironmentVariable[];
  geocoding: GeocodingPreferences;
}

export type ProjectPluginControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ProjectPluginState {
  manifestUrls: string[];
  activePluginIds: string[];
  mapControlPositions: Record<string, ProjectPluginControlPosition>;
  settings: Record<string, unknown>;
}

export const DEFAULT_PROJECT_PREFERENCES: ProjectPreferences = {
  map: {
    restrictBounds: false,
    bounds: [-180, -85, 180, 85],
    minZoom: 0,
    maxZoom: 24,
    maxPitch: 85,
    renderWorldCopies: true,
    projection: "globe",
  },
  environmentVariables: [],
  geocoding: {
    providerId: "nominatim",
    apiKeys: {},
  },
};

/**
 * A single user override for one legend item, keyed in {@link LegendConfig.overrides}
 * by a stable item key (a layer id for a whole entry, or `${layerId}::${index}`
 * for an individual class within a graduated/categorized entry).
 */
export interface LegendItemOverride {
  /** User-supplied label that replaces the auto-generated one. */
  label?: string;
  /** When true, the item is omitted from the rendered legend. */
  hidden?: boolean;
}

/**
 * User customizations for the Print Layout legend. The legend itself is always
 * derived from the visible layers' symbology; this record only stores the edits
 * layered on top (title, ordering, per-item rename/hide), so it survives layer
 * additions and removals and is persisted in the `.geolibre.json` project.
 */
export interface LegendConfig {
  /** Heading drawn above the legend entries. */
  title: string;
  /** When true, classes are grouped under a per-layer heading. */
  groupByLayer: boolean;
  /**
   * Custom top-level entry order by layer id, top-first. Layer ids not listed
   * keep their default order after the listed ones.
   */
  order: string[];
  /** Per-item overrides keyed by stable item key. */
  overrides: Record<string, LegendItemOverride>;
}

// Frozen so the shared singleton can be safely spread (`{ ...DEFAULT_LEGEND_CONFIG }`)
// at call sites without risk of a future in-place mutation corrupting the nested
// `order`/`overrides` references that the spread keeps sharing.
export const DEFAULT_LEGEND_CONFIG: LegendConfig = Object.freeze({
  title: "Legend",
  groupByLayer: true,
  order: Object.freeze([] as string[]) as string[],
  overrides: Object.freeze({} as Record<string, LegendItemOverride>) as Record<
    string,
    LegendItemOverride
  >,
});

/** Camera target captured for a story chapter. */
export interface StoryChapterLocation {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/** Where a chapter's text panel sits over the map. */
export type StoryChapterAlignment = "left" | "center" | "right" | "full";

/** How the map transitions to a chapter's location. */
export type StoryChapterAnimation = "flyTo" | "easeTo" | "jumpTo";

/** A layer opacity change triggered when a chapter is entered or exited. */
export interface StoryLayerOpacityChange {
  /** Stable identity for React list keys; optional for older project files. */
  id?: string;
  /** GeoLibre store layer id whose opacity should change. */
  layerId: string;
  opacity: number;
  /** Transition duration in milliseconds. */
  duration?: number;
}

/** A single scene in a scroll-driven story map. */
export interface StoryChapter {
  id: string;
  title: string;
  description: string;
  /** Optional image shown in the chapter panel (URL or data URI). */
  image?: string;
  alignment: StoryChapterAlignment;
  /** Hide the text panel while still transitioning the map. */
  hidden: boolean;
  location: StoryChapterLocation;
  mapAnimation: StoryChapterAnimation;
  /** Slowly rotate the camera once the transition settles. */
  rotateAnimation: boolean;
  onChapterEnter: StoryLayerOpacityChange[];
  onChapterExit: StoryLayerOpacityChange[];
}

export type StoryInsetPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Scroll-driven story map authored on top of a GeoLibre project. */
export interface StoryMap {
  title: string;
  subtitle: string;
  byline: string;
  footer: string;
  theme: "light" | "dark";
  showMarkers: boolean;
  markerColor: string;
  inset: boolean;
  insetPosition: StoryInsetPosition;
  chapters: StoryChapter[];
}

export const DEFAULT_STORY_MAP: StoryMap = {
  title: "",
  subtitle: "",
  byline: "",
  footer: "",
  theme: "dark",
  showMarkers: false,
  markerColor: "#3fb1ce",
  inset: false,
  insetPosition: "bottom-left",
  chapters: [],
};

/**
 * One step in a {@link ProcessingModel}: a processing tool invoked with a fixed
 * set of parameters. The runner chains steps by feeding each step's output layer
 * into the next step's input layer parameter (`inputParam`, default `"layer"`),
 * so a step's stored `parameters` for that input is ignored for every step after
 * the first.
 */
export interface ProcessingModelStep {
  /** Stable id, unique within the model (used as the React key and run label). */
  id: string;
  /** The processing tool's registry id (e.g. `"buffer"`). */
  toolId: string;
  /** Parameter values keyed by the tool's parameter ids. */
  parameters: Record<string, unknown>;
  /**
   * Which `type: "layer"` parameter receives the previous step's output. Defaults
   * to `"layer"`; set it for tools whose primary input is named differently.
   */
  inputParam?: string;
}

/**
 * A reusable, sequential processing pipeline ("model" in QGIS Graphical Modeler
 * / ArcGIS ModelBuilder terms). Steps run in order; each step's result feeds the
 * next. Saved in the project file so it can be reloaded and re-run.
 */
export interface ProcessingModel {
  id: string;
  name: string;
  steps: ProcessingModelStep[];
}

/** Column-count bounds for the Dashboard panel's widget grid. */
export const MIN_DASHBOARD_COLUMNS = 1;
export const MAX_DASHBOARD_COLUMNS = 6;
export const DEFAULT_DASHBOARD_COLUMNS = 2;

/** The chart a {@link DashboardWidget} draws. Mirrors the attribute Charts
 * panel's types so a widget reuses the same rendering. */
export type DashboardWidgetType =
  | "histogram"
  | "scatter"
  | "bar"
  | "line"
  | "box"
  | "pie";

/** How a bar widget reduces its category groups. */
export type DashboardWidgetAggregation = "count" | "sum" | "mean";

/**
 * One chart in the Dashboard panel: a chart type bound to a layer and the
 * field(s) it plots. Which `field*`/`category`/`aggregation` keys apply depends
 * on `type` (histogram/line/box use `field`; scatter uses `xField`/`yField`;
 * bar uses `category` + `aggregation` and, for sum/mean, `valueField`). Unused
 * keys are simply ignored, so the record stays flat and easy to hand-edit.
 * Saved in the project file so a dashboard reopens with its widgets intact.
 */
export interface DashboardWidget {
  /** Stable id, unique within the project (React key and store key). */
  id: string;
  /** The layer whose features feed this widget. */
  layerId: string;
  /** The chart to draw. */
  type: DashboardWidgetType;
  /** Optional custom title; the panel derives a label from the fields if absent. */
  title?: string;
  /** Optional hex color (`#rgb`/`#rrggbb`) for the chart's marks. Single-series
   * charts use it as the series color; bar/pie use it as the base of a
   * monochromatic ramp. Defaults to the theme primary / multi-color palette. */
  color?: string;
  /** Value field for histogram/line/box. */
  field?: string;
  /** X-axis field for scatter. */
  xField?: string;
  /** Y-axis field for scatter. */
  yField?: string;
  /** Number of bins for a histogram. */
  bins?: number;
  /** Category field for a bar chart. */
  category?: string;
  /** Aggregation for a bar chart (default `count`). */
  aggregation?: DashboardWidgetAggregation;
  /** Value field a bar chart's sum/mean reduces (ignored for `count`). */
  valueField?: string;
}

export interface GeoLibreProject {
  version: string;
  name: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  /** Named folders that organize the flat `layers` list in the layer panel. */
  layerGroups?: LayerGroup[];
  styles: Record<string, LayerStyle>;
  preferences: ProjectPreferences;
  plugins?: ProjectPluginState;
  /** User customizations for the Print Layout legend. */
  legend?: LegendConfig;
  storymap?: StoryMap;
  /** Saved processing pipelines (batch/model chaining; issue #344). */
  models?: ProcessingModel[];
  /** Saved Dashboard panel chart widgets (issue #401). */
  widgets?: DashboardWidget[];
  /** Number of columns in the Dashboard widget grid; omitted when default. */
  dashboardColumns?: number;
  metadata: Record<string, unknown>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string;
}
