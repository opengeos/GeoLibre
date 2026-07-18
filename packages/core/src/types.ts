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

export type VectorStyleMode = "single" | "graduated" | "categorized" | "rule-based" | "expression";

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
  /**
   * When true this is the catch-all "else" rule: {@link filter} is unused and
   * the rule is an unconditional fallback for features no other rule matched,
   * so the {@link minZoom}/{@link maxZoom} and {@link parentId} fields are
   * ignored on it. Its symbol overrides and {@link enabled} toggle do apply.
   */
  isElse: boolean;
  /**
   * Whether the rule participates in rendering. `false` temporarily disables
   * the rule (and, for a group, its whole subtree) without deleting it,
   * mirroring the QGIS rule checkbox. Absent means enabled.
   */
  enabled?: boolean;
  /**
   * Lowest zoom (inclusive) the rule applies at, mirroring MapLibre's layer
   * `minzoom` convention. Absent means no lower bound.
   */
  minZoom?: number;
  /**
   * Zoom the rule stops applying at (exclusive, like MapLibre's layer
   * `maxzoom`). Absent means no upper bound. Together with {@link minZoom}
   * this is the QGIS per-rule "scale range".
   */
  maxZoom?: number;
  /**
   * The id of the parent rule when this rule is nested inside a group (QGIS
   * rule tree). A child rule matches only features that also match every
   * ancestor's filter, and inherits the intersection of the ancestors' zoom
   * ranges and enabled state. A rule that has children acts as a group: its
   * own symbol is not rendered; only leaf rules draw. Absent or dangling
   * means a top-level rule.
   */
  parentId?: string;
  /**
   * Per-rule stroke/outline color override (6-digit hex): the polygon outline
   * and circle stroke color for matching features. Absent inherits the layer
   * {@link LayerStyle.strokeColor}.
   */
  strokeColor?: string;
  /**
   * Per-rule stroke width override in pixels: the line width (lines and
   * polygon outlines) and circle stroke width for matching features. Absent
   * inherits the layer {@link LayerStyle.strokeWidth}.
   */
  strokeWidth?: number;
  /**
   * Per-rule fill/circle opacity override (0..1) for matching features.
   * Absent inherits the layer {@link LayerStyle.fillOpacity}.
   */
  fillOpacity?: number;
  /**
   * Per-rule circle radius override in pixels for matching point features.
   * Absent inherits the layer {@link LayerStyle.circleRadius}.
   */
  circleRadius?: number;
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
 * The repeated decoration symbol drawn along line features (and polygon
 * outlines), or `"none"` when decorations are off. Mirrors the QGIS
 * marker-line / arrow symbol layers: `"arrow"` renders directional arrowheads
 * that follow the line, the other shapes render as repeated markers.
 */
export type LineDecoration = "none" | "arrow" | "triangle" | "circle" | "square";

/**
 * The per-feature derived geometry rendered by the geometry generator, or
 * `"none"` when the generator is off. Mirrors QGIS geometry-generator symbol
 * layers: each feature's derived geometry (its centroid, bounding box, convex
 * hull, or a buffer) is drawn as an extra symbol over the layer's normal
 * symbology. `"centroid"` derives points; the rest derive polygons.
 */
export type GeometryGeneratorType = "none" | "centroid" | "bounding-box" | "convex-hull" | "buffer";

/**
 * Unit a stroke/line width is measured in. `"pixels"` is constant screen space;
 * `"meters"` is ground distance, so the rendered width scales with the map
 * scale (zoom). See {@link LayerStyle.strokeWidthUnit}.
 */
export type StrokeWidthUnit = "pixels" | "meters";

/**
 * The chart drawn on top of each feature by the diagram renderer (QGIS-style
 * diagram symbology), or `"none"` when diagrams are off. Diagrams visualize
 * several numeric attributes per feature at once — e.g. election results by
 * party per county — and render through the shared deck.gl overlay on the
 * feature's point location or polygon centroid.
 */
export type DiagramType = "none" | "pie" | "donut" | "bar" | "stacked-bar";

/**
 * How the overall diagram size is determined.
 *
 * - `"fixed"`: every diagram renders at {@link LayerStyle.diagramSize} pixels.
 * - `"sum"`: scaled by the sum of the mapped attribute values, so the largest
 *   total renders at {@link LayerStyle.diagramSize} pixels (area-true square
 *   root scaling).
 * - `"attribute"`: scaled the same way by the single numeric attribute in
 *   {@link LayerStyle.diagramSizeProperty}.
 */
export type DiagramSizeMode = "fixed" | "sum" | "attribute";

/** One attribute rendered as a slice/bar of a feature diagram. */
export interface DiagramField {
  /** Numeric feature property visualized by this slice/bar. */
  property: string;
  /** Slice/bar color (6-digit hex). */
  color: string;
}

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
  /**
   * Where the label sits relative to its anchor point (MapLibre `text-anchor`),
   * e.g. `"top"` places the text above the point. Ignored for line placement.
   */
  anchor: LabelAnchor;
  /** Horizontal label offset in ems (MapLibre `text-offset` x). */
  offsetX: number;
  /** Vertical label offset in ems (MapLibre `text-offset` y; positive is down). */
  offsetY: number;
  /** Label rotation in degrees clockwise (MapLibre `text-rotate`). */
  rotation: number;
  /** Maximum line width in ems before the label wraps (MapLibre `text-max-width`). */
  maxWidth: number;
  /** Letter-case transform applied to the label text (MapLibre `text-transform`). */
  transform: LabelTransform;
  /**
   * How to handle features that share a label.
   *
   * - `"off"`: every feature is labeled (the historical behavior).
   * - `"unique"`: features stacked at the same point are collapsed to a single
   *   label, so co-located points (e.g. several antennas at one cell site) do not
   *   stack overlapping text.
   * - `"concatenate"`: co-located points are merged into one label that joins
   *   their distinct {@link field} values, one per line.
   *
   * Applies to point layers rendered through the inline GeoJSON path and uses
   * {@link field} (not {@link expression}) as the label value.
   */
  dedupe: LabelDedupe;
  /**
   * Data-defined override for {@link size}: a MapLibre expression (JSON
   * string) producing a number, e.g. sizing labels by population. Empty means
   * "use the literal {@link size}". Like the other data-defined overrides
   * below, it reads source feature attributes, so it is skipped while
   * {@link dedupe} collapsing is active (the aggregated features carry only
   * the label value).
   */
  sizeExpression: string;
  /**
   * Data-defined override for {@link color}: a MapLibre expression (JSON
   * string) producing a color, e.g. coloring labels by category.
   */
  colorExpression: string;
  /**
   * Data-defined label opacity: a MapLibre expression (JSON string) producing
   * a number in 0..1. When set it replaces the layer-wide opacity for labels
   * (wrapping it would invalidate top-level `["zoom"]` interpolations).
   */
  opacityExpression: string;
  /**
   * Per-feature label visibility: a MapLibre expression (JSON string)
   * producing a boolean. Features evaluating false get no label (e.g. hide
   * labels below an attribute threshold). Combined with the layer's other
   * feature filters.
   */
  visibilityExpression: string;
  /**
   * Per-feature placement priority: a MapLibre expression (JSON string)
   * producing a number, applied as `symbol-sort-key`. Labels with lower
   * values are placed first, so they win when space is tight.
   */
  priorityExpression: string;
}

/** MapLibre `text-anchor` positions offered for {@link LabelStyle.anchor}. */
export type LabelAnchor =
  | "center"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Letter-case transform offered for {@link LabelStyle.transform}. */
export type LabelTransform = "none" | "uppercase" | "lowercase";

/** Duplicate-label handling offered for {@link LabelStyle.dedupe}. */
export type LabelDedupe = "off" | "unique" | "concatenate";

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
  /**
   * When true, a vector layer whose coordinates carry Z values (e.g. a GPX
   * track with elevations) renders in true 3D through the shared deck.gl
   * overlay instead of MapLibre's flat 2D layers, so features sit at their
   * own altitude. Orthogonal to {@link extrusionEnabled}, which extrudes flat
   * polygons by an attribute; only one of the two should be on at a time.
   */
  elevation3dEnabled: boolean;
  /** Multiplier applied to each coordinate's Z value (vertical exaggeration). */
  elevation3dVerticalScale: number;
  /** Constant altitude offset in meters added after the vertical scale. */
  elevation3dOffset: number;
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
  /**
   * Per-feature chart symbology (QGIS-style diagrams). `"none"` disables it;
   * any other value renders one {@link DiagramType} chart per feature over the
   * layer's normal symbology, built from the numeric attributes in
   * {@link diagramFields}. See `@geolibre/core`'s `diagram.ts` helpers.
   */
  diagramType: DiagramType;
  /** Attributes (and their colors) charted by the diagram renderer, in order. */
  diagramFields: DiagramField[];
  /** How the per-feature diagram size is determined. */
  diagramSizeMode: DiagramSizeMode;
  /**
   * Diagram size in pixels: the rendered diameter/height for `"fixed"` sizing,
   * or the diameter/height of the largest feature for scaled sizing.
   */
  diagramSize: number;
  /** Numeric attribute driving `"attribute"` sizing (see {@link DiagramSizeMode}). */
  diagramSizeProperty: string;
  /** Minimum zoom at which diagrams are drawn, to avoid clutter when zoomed out. */
  diagramMinZoom: number;
  /**
   * When true, diagrams that would overlap an already-placed diagram on screen
   * are skipped (largest first), decluttering dense areas. Recomputed as the
   * view changes.
   */
  diagramDeclutter: boolean;
  pointRenderer: PointRenderer;
  heatmapRadius: number;
  heatmapIntensity: number;
  clusterRadius: number;
  clusterMaxZoom: number;
  /**
   * When true, the polygon fill renders *inverted*: the area outside the
   * features is filled (with {@link fillColor}/{@link fillOpacity}) and the
   * features themselves become holes, mirroring the QGIS "Inverted polygons"
   * renderer. Feature outlines still render normally. Only applies to layers
   * with polygon geometry; ignored while {@link extrusionEnabled} is on.
   */
  invertedFillEnabled: boolean;
  /**
   * Repeated decoration symbol drawn along line features and polygon outlines
   * (QGIS marker-line / arrow lines). `"none"` disables it. See
   * {@link LineDecoration}.
   */
  lineDecoration: LineDecoration;
  /**
   * Decoration symbol color (6-digit hex). An empty string inherits
   * {@link strokeColor} so decorations follow the stroke by default.
   */
  lineDecorationColor: string;
  /** Decoration symbol size in pixels. */
  lineDecorationSize: number;
  /** Distance between consecutive decoration symbols in pixels. */
  lineDecorationSpacing: number;
  /**
   * Per-feature derived geometry drawn over the layer's normal symbology
   * (QGIS geometry generator). `"none"` disables it. See
   * {@link GeometryGeneratorType}.
   */
  geometryGenerator: GeometryGeneratorType;
  /** Buffer distance in meters for the `"buffer"` generator. */
  geometryGeneratorBufferDistance: number;
  /** Fill color (6-digit hex) for generated polygons and centroid points. */
  geometryGeneratorFillColor: string;
  /** Outline color (6-digit hex) for generated geometry. */
  geometryGeneratorStrokeColor: string;
  /** Outline width in pixels for generated geometry. */
  geometryGeneratorStrokeWidth: number;
  /** Fill opacity (0..1) for generated polygons and centroid points. */
  geometryGeneratorOpacity: number;
  /** Circle radius in pixels for generated centroid points. */
  geometryGeneratorCircleRadius: number;
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
    anchor: "center",
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    maxWidth: 10,
    transform: "none",
    dedupe: "off",
    sizeExpression: "",
    colorExpression: "",
    opacityExpression: "",
    visibilityExpression: "",
    priorityExpression: "",
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
  elevation3dEnabled: false,
  elevation3dVerticalScale: 1,
  elevation3dOffset: 0,
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
  diagramType: "none",
  diagramFields: [],
  diagramSizeMode: "fixed",
  diagramSize: 30,
  diagramSizeProperty: "",
  diagramMinZoom: 0,
  diagramDeclutter: false,
  pointRenderer: "single",
  heatmapRadius: 30,
  heatmapIntensity: 1,
  clusterRadius: 50,
  clusterMaxZoom: 14,
  invertedFillEnabled: false,
  lineDecoration: "none",
  lineDecorationColor: "",
  lineDecorationSize: 12,
  lineDecorationSpacing: 80,
  geometryGenerator: "none",
  geometryGeneratorBufferDistance: 1000,
  geometryGeneratorFillColor: "#f59e0b",
  geometryGeneratorStrokeColor: "#b45309",
  geometryGeneratorStrokeWidth: 2,
  geometryGeneratorOpacity: 0.4,
  geometryGeneratorCircleRadius: 5,
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
export function styleValue<K extends keyof LayerStyle>(style: LayerStyle, key: K): LayerStyle[K] {
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
export function shouldUseTiledRendering(geojson: GeoJSON.FeatureCollection | undefined): boolean {
  return (geojson?.features.length ?? 0) > LARGE_VECTOR_FEATURE_THRESHOLD;
}

/**
 * Match statistics from the last time a {@link LayerJoin} was applied, shown in
 * the Joins UI so silent key mismatches are visible (mirrors QGIS's join
 * feedback). Recomputed on every apply; persisted harmlessly with the join.
 */
export interface LayerJoinStats {
  /** Target features whose key matched a join-table row. */
  matchedCount: number;
  /** Target features with no matching join-table row (their joined columns are null). */
  unmatchedTargetCount: number;
  /** Join-table rows (with a non-empty key) that matched no target feature. */
  unmatchedJoinCount: number;
}

/**
 * A persistent attribute join attached to a layer (QGIS Layer Properties →
 * Joins): a live left join that augments the layer's attribute table with
 * columns from another layer (typically a geometry-less table added via
 * Delimited Text with no coordinate fields) matched on a key field. Unlike the
 * Processing → Vector attribute join, the layer keeps its identity — styles,
 * labels, and position — and the joined columns refresh whenever the join
 * table's data changes. Definitions persist in `.geolibre.json` and re-resolve
 * on project load. See `joins.ts` for the engine.
 */
export interface LayerJoin {
  /** Stable id for list edits. */
  id: string;
  /** Id of the layer providing the joined columns (its geometry is ignored). */
  joinLayerId: string;
  /** Key field on the layer that owns this join. */
  targetField: string;
  /** Key field on the join layer. */
  joinField: string;
  /**
   * Join-layer fields to bring over; `undefined` brings every field except the
   * key. Names are the join layer's own (pre-prefix) field names.
   */
  fields?: string[];
  /** Optional prefix prepended to every joined column name (as in QGIS). */
  prefix?: string;
  /** `false` detaches the joined columns without deleting the definition. */
  enabled?: boolean;
  /**
   * Bookkeeping written by the engine: the output column names this join added
   * to the layer's features. Applying joins strips these first, which makes
   * re-application idempotent without keeping a duplicate copy of the base
   * data (base columns always win a name collision, so a joined column never
   * shadows one). Not user-editable.
   */
  addedFields?: string[];
  /** Last-run match statistics; see {@link LayerJoinStats}. */
  stats?: LayerJoinStats;
}

/** Edit-widget kinds the Attribute Form designer can assign to a field. */
export type AttributeFormWidget = "text" | "number" | "range" | "checkbox" | "date" | "valueMap";

/** One selectable entry of a `valueMap` widget (stored value + display label). */
export interface AttributeFormValueMapEntry {
  /** The value written to the feature property (compared as a string). */
  value: string;
  /** Human-readable label shown in the dropdown; defaults to {@link value}. */
  label?: string;
}

/**
 * Per-field configuration authored in the Attribute Form designer (layer
 * properties → Attributes Form, QGIS-style): which edit widget the attribute
 * editing surfaces render for the field, plus optional expression-based
 * constraints and conditional visibility. Consumed by the attribute table's
 * inline editor and the Field Collection capture form; helpers live in
 * `attribute-form.ts`.
 */
export interface AttributeFormFieldConfig {
  /** Feature property key this configuration applies to. */
  field: string;
  widget: AttributeFormWidget;
  /** Display label override shown in forms instead of the raw field name. */
  alias?: string;
  /**
   * When true, a null/empty value fails validation. Checkbox widgets are
   * exempt: unchecked is a valid state, not a missing value.
   */
  required?: boolean;
  /** Dropdown entries for the `valueMap` widget. */
  valueMap?: AttributeFormValueMapEntry[];
  /** Lower bound for `number`/`range` widgets (inclusive). */
  min?: number;
  /** Upper bound for `number`/`range` widgets (inclusive). */
  max?: number;
  /** Step for the `range` widget's input. */
  step?: number;
  /**
   * Boolean MapLibre expression that must evaluate to `true` against the
   * feature's (candidate) properties for the value to be accepted, e.g.
   * `[">", ["get", "population"], 0]`. Stored as the expression source string
   * the Expression Builder edits.
   */
  constraintExpression?: string;
  /** Human-readable message shown when the constraint fails. */
  constraintDescription?: string;
  /**
   * Boolean MapLibre expression controlling whether the field is shown in
   * attribute forms; `false` hides the field (and skips its validation).
   * Empty/invalid expressions fail open so a typo cannot hide data entry.
   */
  visibilityExpression?: string;
}

/** The Attribute Form designer's whole per-layer configuration. */
export interface AttributeFormConfig {
  fields: AttributeFormFieldConfig[];
}

/**
 * A virtual field attached to a vector layer (QGIS Field Calculator → "Create
 * virtual field", issue #1321): a column defined by a MapLibre expression that
 * recomputes live instead of being written once as static values. The engine
 * (`virtual-fields.ts`) materializes the computed values into the layer's
 * feature properties — so the attribute table, Expression Builder,
 * data-driven styling, labels, and selection all see the column with no
 * further wiring — and re-derives them whenever the layer's data (or its
 * joins) change. Definitions persist in `.geolibre.json` and re-resolve on
 * project load; the expression is a declarative MapLibre expression (never
 * arbitrary code), so re-evaluating it from a shared project file is safe.
 */
export interface LayerVirtualField {
  /** Stable id for list edits. */
  id: string;
  /** The output column name. A name already taken by a base column is skipped. */
  name: string;
  /**
   * MapLibre expression source (JSON text, e.g. `["/", ["get", "pop"],
   * ["get", "area_km2"]]`) evaluated against each feature.
   */
  expression: string;
  /** `false` detaches the computed column without deleting the definition. */
  enabled?: boolean;
  /**
   * Bookkeeping written by the engine: the column name actually materialized
   * on the last apply, absent when the field was disabled, failed to compile,
   * or was skipped because the name collided with an existing column.
   * Applying virtual fields strips these first, which makes re-application
   * idempotent (an existing column is never shadowed, so stripping exactly
   * restores the pre-apply properties). Not user-editable.
   */
  addedField?: string;
  /** Compile error from the last apply, when the expression failed to parse. */
  error?: string;
  /**
   * Features whose evaluation threw at runtime on the last apply (their cell
   * is null). Surfaced so the UI can warn without one bad feature aborting
   * the whole column.
   */
  errorCount?: number;
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
   * Per-field edit-widget, constraint, and visibility configuration authored
   * in the Attribute Form designer. Applied by the attribute editing surfaces
   * (attribute table inline editor, Field Collection capture form); persists
   * with the project like {@link joins}.
   */
  attributeForm?: AttributeFormConfig;
  /**
   * Persistent attribute joins applied to this layer's features, in order.
   * The joined columns are materialized into `geojson` feature properties (so
   * the attribute table, Expression Builder, styling, and labels all see them)
   * and re-derived whenever the layer's or a join table's data changes.
   */
  joins?: LayerJoin[];
  /**
   * Expression-backed virtual fields computed for this layer's features, in
   * order. Applied after joins (so an expression can read joined columns) and
   * materialized into `geojson` feature properties; re-derived whenever the
   * layer's data changes. See {@link LayerVirtualField}.
   */
  virtualFields?: LayerVirtualField[];
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
 * Options for {@link AppState.addTileLayer}: a native raster tile layer (XYZ,
 * WMS, or WMTS) that appears in the Layers panel and persists with the project,
 * just like a layer added through the Add Data dialog. Mirrors the raster
 * `source` fields MapLibre understands so an external plugin can register tile
 * layers without touching the map directly.
 */
export interface AddTileLayerOptions {
  /**
   * One or more XYZ tile URL templates (with `{x}`/`{y}`/`{z}` placeholders).
   * At least one non-empty template is required, or the layer renders nothing.
   */
  tiles: string[];
  /**
   * Layer discriminator, controlling how the layer is labelled and (for WMS)
   * dev-server proxied. Defaults to `"xyz"`.
   */
  type?: "xyz" | "wms" | "wmts" | "raster";
  /** Service or base URL recorded on the source for display and restore. */
  url?: string;
  /** Tile size in pixels (default 256). */
  tileSize?: number;
  /** Attribution string shown in the map's attribution control. */
  attribution?: string;
  /** Visible extent as `[west, south, east, north]` in WGS84 degrees. */
  bounds?: [number, number, number, number];
  /** Minimum zoom at which tiles are requested. */
  minzoom?: number;
  /** Maximum zoom at which tiles are requested. */
  maxzoom?: number;
  /** Tile y-axis scheme; `"tms"` flips the y origin. Defaults to `"xyz"`. */
  scheme?: "xyz" | "tms";
  /** Initial visibility (default true). */
  visible?: boolean;
  /** Initial opacity in [0, 1] (default 1). */
  opacity?: number;
  /**
   * Extra source fields merged onto the layer's `source` (e.g. the WMS
   * `layers`/`styles`/`format` recorded for restore). The required `type`,
   * `tiles`, and `tileSize` always win over keys supplied here.
   */
  source?: Record<string, unknown>;
  /** Extra metadata merged onto the layer record. */
  metadata?: Record<string, unknown>;
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
 * Metadata `sourceKind` marking a live SQL query layer: a GeoJSON-backed layer
 * created from a SQL Workspace result whose DuckDB statement is stored on the
 * layer metadata and re-executed on refresh. Defined here so the desktop app
 * (which owns the query/refresh logic) and `@geolibre/plugins` (which excludes
 * these layers from in-place geometry editing) share one value.
 */
export const SQL_QUERY_SOURCE_KIND = "sql-query";

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
 * Multi-map (split/grid) support. The workspace can show several map panes in a
 * `rows x cols` grid. Pane 0 is always the *primary* map: it keeps the existing
 * single-map wiring (the global `mapView` + `basemap*` fields, the layer/style
 * panels, plugins, deck.gl). Panes 1..N are *secondary* maps described by
 * `SecondaryMapView` records: every pane shares the same basemap and the same
 * `layers`, but each secondary pane may override which layers are visible so
 * different panes can show different layers. When `syncView` is on,
 * panning/zooming any pane mirrors the camera to every other pane.
 */
export interface MapGridLayout {
  /** Grid rows (>= 1). */
  rows: number;
  /** Grid columns (>= 1). `rows * cols` is the total number of panes. */
  cols: number;
  /** When true, all panes share a synchronized camera. */
  syncView: boolean;
}

/**
 * A non-primary map pane: shares the primary map's basemap and layers, with its
 * own camera and per-layer visibility overrides.
 */
export interface SecondaryMapView {
  /** Stable id, used as the React key and the sync-group registration id. */
  id: string;
  view: MapViewState;
  /** Optional user-entered label shown on the pane (e.g. a date or scenario). */
  label?: string;
  /**
   * Which rendering engine draws this pane. Defaults to `"maplibre"` (the 2D
   * map) when absent, so existing projects and panes are unchanged. `"cesium"`
   * renders a 3D globe (see {@link CesiumCanvas}) over the same shared layers.
   */
  viewKind?: "maplibre" | "cesium";
  /**
   * Per-layer visibility overrides keyed by layer id. A layer absent from this
   * map inherits the primary map's visibility (`layer.visible`); an entry forces
   * the layer visible (`true`) or hidden (`false`) in this pane only.
   */
  layerVisibility: Record<string, boolean>;
}

/** The default single-map grid (one pane, sync enabled so it turns on cleanly). */
export const DEFAULT_MAP_GRID_LAYOUT: MapGridLayout = {
  rows: 1,
  cols: 1,
  syncView: true,
};

/** Maximum rows or columns in the map grid (so at most a 4x4 = 16-pane grid). */
export const MAX_MAP_GRID_DIM = 4;

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
  /**
   * Host-set per-participant edit override (#754). `null` follows the session
   * `mode`; `true`/`false` pins this participant to can-edit / view-only. Always
   * `null` for the host (the host can always edit).
   */
  editOverride: boolean | null;
}

/** A remote participant's live cursor + viewport, used to render presence. */
export interface CollaborationPresence {
  displayName: string;
  color: string;
  cursor?: { lng: number; lat: number } | null;
  view?: MapViewState | null;
}

/** One in-session chat message (#754). Ephemeral; never persisted to a project. */
export interface CollaborationChatMessage {
  /** Server-assigned id (stable React key / dedupe). */
  id: string;
  /** clientId of the author. */
  clientId: string;
  displayName: string;
  color: string;
  text: string;
  /** Optional map coordinate the author attached; clickable to recenter. */
  coordinate?: { lng: number; lat: number } | null;
  /** Server-assigned epoch-ms timestamp. */
  ts: number;
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
  /** Recent session chat, oldest first, capped to a bounded window (#754). */
  chat: CollaborationChatMessage[];
  /** Last human-readable error, surfaced in the Collaborate dialog. */
  error: string | null;
}

/** Map projection the renderer uses. Mirrors the GlobeControl toggle. */
export type MapProjection = "globe" | "mercator";

/**
 * Unit system the scale bar reports distances in. `"metric"` uses m/km,
 * `"imperial"` uses ft/mi, and `"nautical"` uses nautical miles.
 */
export type MapScaleUnit = "metric" | "imperial" | "nautical";

export interface MapPreferences {
  restrictBounds: boolean;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  maxPitch: number;
  renderWorldCopies: boolean;
  projection: MapProjection;
  /**
   * Celestial body / ellipsoid the project's coordinates describe (keys into the
   * ellipsoid registry in `@geolibre/core`). Drives measurement radii and pairs
   * with planetary basemaps. Defaults to `"earth"` (WGS 84).
   */
  ellipsoidId: string;
  /**
   * Unit system the scale bar displays. Defaults to `"metric"`; switch to
   * `"imperial"` for feet/miles or `"nautical"` for nautical miles.
   */
  scaleUnit: MapScaleUnit;
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
    ellipsoidId: "earth",
    scaleUnit: "metric",
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

export type StoryInsetPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * A non-chapter intro/outro slide shown before the first or after the last
 * chapter (#998). `"none"` disables it. The remaining modes are:
 * - `"blank"` a solid screen in the panel theme color,
 * - `"black"` a solid black screen,
 * - `"global"` a zoomed-out global view of the map with no text,
 * - `"adjacent"` the camera of the neighboring chapter (the first chapter for
 *   the start slide, the last chapter for the closing slide) with all text and
 *   media hidden, so the presenter can zoom into the full content next.
 */
export type StorySlideMode = "none" | "blank" | "black" | "global" | "adjacent";

/** A start/closing slide that is actually shown (every mode except `"none"`). */
export type StoryActiveSlideMode = Exclude<StorySlideMode, "none">;

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
  /**
   * Start the presentation with the chapter itinerary/navigation panel hidden,
   * revealing chapters one at a time instead of listing every upcoming location
   * up front (#995). The presenter still offers a toggle to open the list.
   */
  hideChapterNav: boolean;
  /** Optional intro slide shown before the first chapter (#998). */
  startSlide: StorySlideMode;
  /** Optional closing slide shown after the last chapter (#998). */
  endSlide: StorySlideMode;
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
  hideChapterNav: false,
  startSlide: "none",
  endSlide: "none",
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

/**
 * Which dialog family executed a {@link ProcessingRun}. Drives the History
 * panel's re-run routing: each kind maps to the dialog (and store open-flag)
 * that can be reopened pre-filled with the run's parameters.
 */
export type ProcessingRunKind =
  | "vector"
  | "statistics"
  | "network"
  | "whitebox"
  | "raster"
  | "conversion"
  | "algorithm";

export type ProcessingRunStatus = "success" | "error";

/** Upper bound on persisted processing-history entries (oldest are dropped). */
export const MAX_PROCESSING_HISTORY = 100;

/**
 * One recorded processing tool run (issue #1292). Appended by every processing
 * dialog when a run finishes and persisted in the project file, so a saved
 * project documents how its derived layers were produced. Parameter values are
 * stored exactly as the dialog dispatched them (layer parameters hold layer
 * ids), which is what re-run pre-fills and "Copy as Python" emit.
 */
export interface ProcessingRun {
  /** Stable id, unique within the project (React key and update key). */
  id: string;
  kind: ProcessingRunKind;
  /** The tool's registry id (e.g. `"buffer"`, `"slope"`). */
  toolId: string;
  /** Human-readable tool name captured at run time. */
  toolName: string;
  /** Engine that executed the run: `client`, `wasm`, `sidecar`, `pyodide`, `browser`. */
  engine: string;
  /** Parameter values keyed by the tool's parameter ids. */
  parameters: Record<string, unknown>;
  /** Names of input layers referenced by layer parameters, keyed by layer id. */
  inputLayerNames?: Record<string, string>;
  /** Names of layers the run added to the map. */
  outputLayerNames?: string[];
  /** Input file path/name, for file-based tools (raster/conversion). */
  inputPath?: string;
  /** Output file path/name, for file-based tools (raster/conversion). */
  outputPath?: string;
  /** ISO timestamp of when the run started. */
  startedAt: string;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs?: number;
  status: ProcessingRunStatus;
  /** Error message when `status` is `"error"`. */
  error?: string;
}

/**
 * A pending "re-run from History" request. The History panel writes it to the
 * store and opens the target dialog; the dialog consumes it (pre-filling its
 * parameter form) and clears it. `autoRun` asks the dialog to start the run
 * immediately after pre-filling (plain Re-run vs Edit & re-run).
 */
export interface ProcessingRerunRequest {
  kind: ProcessingRunKind;
  toolId: string;
  parameters: Record<string, unknown>;
  /** Engine to preselect, when the dialog offers a choice. */
  engine?: string;
  autoRun?: boolean;
}

/** Column-count bounds for the Dashboard panel's widget grid. */
export const MIN_DASHBOARD_COLUMNS = 1;
export const MAX_DASHBOARD_COLUMNS = 6;
export const DEFAULT_DASHBOARD_COLUMNS = 2;

/** The chart a {@link DashboardWidget} draws. Mirrors the attribute Charts
 * panel's types so a widget reuses the same rendering. */
export type DashboardWidgetType = "histogram" | "scatter" | "bar" | "line" | "box" | "pie";

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

/**
 * What slice of a layer's styling a Style Manager entry captures (issue #1294).
 *
 * - `"style"`: the layer's complete {@link LayerStyle} snapshot.
 * - `"symbol"`: fill/stroke/marker/pattern symbology only, so it can restyle a
 *   layer without touching its labels or renderer configuration.
 * - `"labels"`: the {@link LabelStyle} block only.
 * - `"ramp"`: the color ramp + classification settings only (ramp name, class
 *   count, classification scheme), independent of the attribute the target
 *   layer classifies on.
 */
export type StyleLibraryEntryKind = "style" | "symbol" | "labels" | "ramp";

/**
 * One saved, reusable style in the Style Manager library (issue #1294). The
 * payload is a {@link LayerStyle} subset chosen by {@link kind}; applying an
 * entry merges that subset onto the target layer's style. Entries live either
 * in the app-level library (persisted across projects) or embedded in a
 * project file's `styleLibrary` array.
 */
export interface StyleLibraryEntry {
  /** Stable id, used as the IndexedDB/store key; upserts overwrite by id. */
  id: string;
  /** Display name shown in the Style Manager. */
  name: string;
  /** Which style subset {@link style} carries. */
  kind: StyleLibraryEntryKind;
  /** Free-form tags for filtering the library. */
  tags: string[];
  /** The saved {@link LayerStyle} subset (see {@link kind}). */
  style: Partial<LayerStyle>;
  /** ISO timestamp of the last save; empty for built-in presets. */
  updatedAt: string;
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
  /** Recorded processing tool runs (Processing History; issue #1292). */
  processingHistory?: ProcessingRun[];
  /** Saved Dashboard panel chart widgets (issue #401). */
  widgets?: DashboardWidget[];
  /** Number of columns in the Dashboard widget grid; omitted when default. */
  dashboardColumns?: number;
  /**
   * Multi-map grid layout; omitted (single 1x1 pane) for default projects so
   * legacy readers and single-map files are unaffected.
   */
  mapLayout?: MapGridLayout;
  /**
   * Secondary map panes (everything past the primary pane). Omitted when the
   * grid is a single pane. The primary pane uses the top-level `mapView` /
   * `basemap*` fields.
   */
  secondaryMapViews?: SecondaryMapView[];
  /** User-entered label for the primary pane; omitted when empty. */
  primaryMapLabel?: string;
  /**
   * Project-scoped Style Manager entries (issue #1294), so a project can carry
   * its reusable styles to teammates. Omitted when empty; the app-level
   * library is persisted outside the project file and never serialized here.
   */
  styleLibrary?: StyleLibraryEntry[];
  metadata: Record<string, unknown>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string;
}
