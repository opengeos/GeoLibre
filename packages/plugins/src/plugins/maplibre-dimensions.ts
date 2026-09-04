import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection, Position } from "geojson";
// A value (not type-only) namespace import: v6 has no default export (see the
// identical note in maplibre-annotations.ts).
import * as maplibregl from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
import { DIMENSIONS_PLUGIN_ID } from "../plugin-ids";
import {
  haversineMeters,
  type LngLat as LngLatTuple,
} from "./elevation-profile/elevation/geometry";

/**
 * Dimension layer plugin: CAD/ArcGIS-Pro-style dimension features (extension
 * lines, a double-arrowhead dimension line, and a measurement label) drawn on
 * the map and stored in the project as a dedicated GeoJSON layer, the way
 * Annotations stores its shapes. Two tools:
 *
 * - **Linear**: a two-point distance dimension, offset perpendicular to the
 *   measured segment by a third, placement click, like a CAD linear
 *   dimension.
 * - **Angular**: a three-point angle dimension (ray, vertex, ray) with an arc
 *   and a degree label.
 *
 * A toolbar "Snap" toggle (on by default) makes every click snap to the
 * nearest vertex of any *visible vector* layer within a small pixel
 * tolerance — raster/tile layers have no vertices to snap to, so they never
 * participate. A snapped endpoint is "tied": the dimension records which
 * layer/feature/vertex it came from, and a store subscription recomputes the
 * dimension's geometry and label whenever that vertex moves (e.g. edited with
 * GeoEditor), the way a CAD associative dimension follows the geometry it
 * measures. An endpoint placed with Snap off (or that lands on no vertex)
 * stays exactly where it was clicked.
 *
 * Rendering reuses the same trick as Annotations' arrow tool: an arrowhead is
 * a small filled triangle polygon sized in screen pixels, not a MapLibre line
 * cap, so it renders through the standard simplestyle layer-sync path with no
 * custom paint code.
 */

export const DIMENSIONS_SOURCE_KIND = "dimension";
const DIMENSIONS_LAYER_NAME = "Dimensions";
const DIMENSIONS_SOURCE_PATH = "dimensions://layer";

const TEXT_MARKER_SHAPE = "text_marker";

const PREVIEW_SOURCE_ID = "geolibre-dimension-preview";
const PREVIEW_FILL_LAYER_ID = "geolibre-dimension-preview-fill";
const PREVIEW_LINE_LAYER_ID = "geolibre-dimension-preview-line";
const PREVIEW_TEXT_LAYER_ID = "geolibre-dimension-preview-text";
const DIMENSION_TOOLS_ID = "geolibre-dimension-tools";

const DEFAULT_COLOR = "#1d4ed8";
const DEFAULT_WIDTH = 2;
const WIDTH_VALUES = [1, 2, 3] as const;
const ARROW_LENGTH_PX = 14;
const ARROW_HALF_WIDTH_PX = 5;
const ARC_SEGMENTS = 48;
const LABEL_RADIUS_PADDING_PX = 14;
const SNAP_TOLERANCE_PX = 12;
// Caps how many vertices (summed across every visible vector layer) are
// indexed for snapping, so a project with huge vector layers can't make every
// mousemove during drawing scan tens of thousands of points. Snapping simply
// stops offering candidates past this many vertices rather than failing.
const MAX_SNAP_CANDIDATES = 4000;

type DimensionTool = "linear" | "angular";

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const DIMENSION_UNITS = {
  m: { label: "Meters", toMeters: 1 },
  km: { label: "Kilometers", toMeters: 1000 },
  ft: { label: "Feet", toMeters: 0.3048 },
  "us-ft": { label: "US Survey Feet", toMeters: 1200 / 3937 },
  yd: { label: "Yards", toMeters: 0.9144 },
  mi: { label: "Miles", toMeters: 1609.344 },
  nmi: { label: "Nautical Miles", toMeters: 1852 },
} as const;

export type DimensionUnit = keyof typeof DIMENSION_UNITS;

const DIMENSION_UNIT_ORDER = Object.keys(DIMENSION_UNITS) as DimensionUnit[];

export function metersToUnit(meters: number, unit: DimensionUnit): number {
  return meters / DIMENSION_UNITS[unit].toMeters;
}

/** Format a distance in meters as `"<value> <unit>"` in the given unit. */
export function formatDistance(meters: number, unit: DimensionUnit, decimals = 2): string {
  return `${metersToUnit(meters, unit).toFixed(decimals)} ${unit}`;
}

/** Format an angle in degrees as `"<value>°"`. */
export function formatAngle(degrees: number, decimals = 1): string {
  return `${degrees.toFixed(decimals)}°`;
}

// ---------------------------------------------------------------------------
// Ties (associative endpoints)
// ---------------------------------------------------------------------------

/** A dimension endpoint tied to a live vertex of a vector layer's feature. */
export interface DimensionTie {
  layerId: string;
  featureId: string | number | null;
  featureIndex: number;
  vertexIndex: number;
}

/** Flatten every vertex of a feature's geometry into a single ordered list. */
export function flattenFeatureVertices(feature: Feature): Position[] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates as Position];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates as Position[];
    case "MultiLineString":
    case "Polygon":
      return (geometry.coordinates as Position[][]).flat();
    case "MultiPolygon":
      return (geometry.coordinates as Position[][][]).flat(2);
    default:
      return [];
  }
}

/** Resolve a tie's current vertex position from the live layer list, or null if it can no longer be resolved. */
export function resolveTiePosition(
  tie: DimensionTie,
  layers: readonly GeoLibreLayer[],
): Position | null {
  const layer = layers.find((candidate) => candidate.id === tie.layerId);
  if (!layer) return null;
  const features = layer.geojson?.features as Feature[] | undefined;
  if (!features) return null;
  const feature =
    (tie.featureId !== null ? features.find((f) => f.id === tie.featureId) : undefined) ??
    features[tie.featureIndex];
  if (!feature) return null;
  const vertices = flattenFeatureVertices(feature);
  return vertices[tie.vertexIndex] ?? null;
}

/** A validated, narrowed `points`/`ties` pair, ready for {@link recomputeAssociativeDimensions} to rebuild. */
export interface ParsedAssociativeDimension {
  kind: DimensionTool;
  points: Position[];
  ties: (DimensionTie | null)[];
}

/**
 * Validate a dimension label feature's properties into the shape
 * {@link recomputeAssociativeDimensions} needs: `points`/`ties` arrays of the
 * length `__dimension` implies (2 for "linear", 3 for "angular"), every point
 * a finite `[lng, lat]` pair, and at least one non-null tie (nothing to
 * recompute otherwise). Returns null for anything else — in particular a
 * Dimensions layer loaded from a saved project or external GeoJSON whose
 * fields don't match, which would otherwise pass `undefined` coordinates (or
 * throw calling `.some` on a non-array `ties`) into the rebuild.
 */
export function parseAssociativeDimension(
  props: Record<string, unknown> | undefined,
): ParsedAssociativeDimension | null {
  const rawKind = props?.__dimension;
  const kind: DimensionTool | null =
    rawKind === "linear" ? "linear" : rawKind === "angular" ? "angular" : null;
  if (kind === null) return null;
  const expectedPointCount = kind === "angular" ? 3 : 2;

  const ties = props?.ties;
  if (!Array.isArray(ties) || ties.length !== expectedPointCount || !ties.some(Boolean)) {
    return null;
  }

  const points = props?.points;
  if (
    !Array.isArray(points) ||
    points.length !== expectedPointCount ||
    points.some(
      (point) =>
        !Array.isArray(point) ||
        point.length < 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]),
    )
  ) {
    return null;
  }

  return { kind, points: points as Position[], ties: ties as (DimensionTie | null)[] };
}

/** A vector layer with at least one feature is a valid snap source; raster/tile layers and Dimension layers are not. */
function isSnapCandidateLayer(layer: GeoLibreLayer): boolean {
  if (isDimensionLayer(layer)) return false;
  if (!layer.visible) return false;
  return (layer.geojson?.features?.length ?? 0) > 0;
}

interface SnapCandidate {
  lngLat: Position;
  tie: DimensionTie;
}

let snapCache: SnapCandidate[] = [];
let snapCacheLayers: readonly GeoLibreLayer[] | null = null;

/** Every vertex of every visible vector layer, up to {@link MAX_SNAP_CANDIDATES}, rebuilt only when the layer list changes. */
function buildSnapCache(): void {
  const layers = useAppStore.getState().layers;
  if (snapCacheLayers === layers) return;
  snapCacheLayers = layers;
  snapCache = [];

  let total = 0;
  for (const layer of layers) {
    if (total >= MAX_SNAP_CANDIDATES) break;
    if (!isSnapCandidateLayer(layer)) continue;
    const features = (layer.geojson?.features as Feature[] | undefined) ?? [];
    for (
      let featureIndex = 0;
      featureIndex < features.length && total < MAX_SNAP_CANDIDATES;
      featureIndex += 1
    ) {
      const feature = features[featureIndex];
      const vertices = flattenFeatureVertices(feature);
      for (
        let vertexIndex = 0;
        vertexIndex < vertices.length && total < MAX_SNAP_CANDIDATES;
        vertexIndex += 1
      ) {
        snapCache.push({
          lngLat: vertices[vertexIndex],
          tie: {
            layerId: layer.id,
            featureId: feature.id ?? null,
            featureIndex,
            vertexIndex,
          },
        });
        total += 1;
      }
    }
  }
}

interface SnapResult {
  lngLat: maplibregl.LngLat;
  tie: DimensionTie;
}

function resolveSnap(map: maplibregl.Map, point: maplibregl.Point): SnapResult | null {
  if (!snapEnabled) return null;
  buildSnapCache();
  if (!snapCache.length) return null;
  let best: { distance: number; candidate: SnapCandidate } | null = null;
  for (const candidate of snapCache) {
    const projected = map.project(candidate.lngLat as [number, number]);
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (distance <= SNAP_TOLERANCE_PX && (!best || distance < best.distance)) {
      best = { distance, candidate };
    }
  }
  if (!best) return null;
  return {
    lngLat: new maplibregl.LngLat(best.candidate.lngLat[0], best.candidate.lngLat[1]),
    tie: best.candidate.tie,
  };
}

// ---------------------------------------------------------------------------
// Geometry construction
// ---------------------------------------------------------------------------

function toLngLat(map: maplibregl.Map, x: number, y: number): Position {
  const lngLat = map.unproject([x, y]);
  return [lngLat.lng, lngLat.lat];
}

/**
 * A drag that never leaves a screen point (or the map has not laid out the
 * projection yet) collapses to a zero-length ring; ensure a consistent
 * winding order the same way Annotations does for its filled shapes.
 */
function ensureCcwRing(ring: Position[]): Position[] {
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea < 0 ? [...ring].reverse() : ring;
}

/** A filled triangle arrowhead in screen pixels, tip at `to`, base toward `from`. */
function arrowheadFeature(
  map: maplibregl.Map,
  from: Position,
  to: Position,
  color: string,
): Feature {
  const fromPx = map.project(from as [number, number]);
  const toPx = map.project(to as [number, number]);
  const dx = toPx.x - fromPx.x;
  const dy = toPx.y - fromPx.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const perpX = -uy;
  const perpY = ux;
  const headLength = Math.min(ARROW_LENGTH_PX, length);
  const baseX = toPx.x - ux * headLength;
  const baseY = toPx.y - uy * headLength;

  const tip = to;
  const left = toLngLat(
    map,
    baseX + perpX * ARROW_HALF_WIDTH_PX,
    baseY + perpY * ARROW_HALF_WIDTH_PX,
  );
  const right = toLngLat(
    map,
    baseX - perpX * ARROW_HALF_WIDTH_PX,
    baseY - perpY * ARROW_HALF_WIDTH_PX,
  );
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [ensureCcwRing([tip, left, right, tip])],
    },
    properties: {
      fill: color,
      "fill-opacity": 1,
      stroke: color,
      "stroke-width": 1,
    },
  };
}

function lineStringFeature(coordinates: Position[], properties: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties,
  };
}

/** Build a linear dimension's six features (2 extensions, the dimension line, 2 arrowheads, 1 label). */
function buildLinearDimensionFeatures(
  map: maplibregl.Map,
  p1: Position,
  p2: Position,
  offsetPx: number,
  unit: DimensionUnit,
  color: string,
  width: number,
  dimensionId: string,
  tie1: DimensionTie | null,
  tie2: DimensionTie | null,
): Feature[] {
  const p1px = map.project(p1 as [number, number]);
  const p2px = map.project(p2 as [number, number]);
  const dx = p2px.x - p1px.x;
  const dy = p2px.y - p1px.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return [];
  const ux = dx / length;
  const uy = dy / length;
  const perpX = -uy;
  const perpY = ux;

  const o1 = toLngLat(map, p1px.x + perpX * offsetPx, p1px.y + perpY * offsetPx);
  const o2 = toLngLat(map, p2px.x + perpX * offsetPx, p2px.y + perpY * offsetPx);
  const labelPos = toLngLat(
    map,
    (p1px.x + p2px.x) / 2 + perpX * offsetPx,
    (p1px.y + p2px.y) / 2 + perpY * offsetPx,
  );

  const lineProps = {
    stroke: color,
    "stroke-width": width,
    "stroke-opacity": 1,
  };
  const extProps = {
    stroke: color,
    "stroke-width": Math.max(1, width - 1),
    "stroke-opacity": 0.85,
  };
  const meters = haversineMeters(p1 as LngLatTuple, p2 as LngLatTuple);
  const text = formatDistance(meters, unit);

  const ext1 = lineStringFeature([p1, o1], {
    dimensionId,
    __dimension: "linear",
    __dimensionPart: "extension",
    ...extProps,
  });
  const ext2 = lineStringFeature([p2, o2], {
    dimensionId,
    __dimension: "linear",
    __dimensionPart: "extension",
    ...extProps,
  });
  const dimLine = lineStringFeature([o1, o2], {
    dimensionId,
    __dimension: "linear",
    __dimensionPart: "line",
    ...lineProps,
  });
  const head1 = arrowheadFeature(map, o2, o1, color);
  const head2 = arrowheadFeature(map, o1, o2, color);
  for (const head of [head1, head2]) {
    Object.assign(head.properties as Record<string, unknown>, {
      dimensionId,
      __dimension: "linear",
      __dimensionPart: "head",
    });
  }
  const label: Feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: labelPos },
    properties: {
      dimensionId,
      __dimension: "linear",
      __dimensionPart: "label",
      shape: TEXT_MARKER_SHAPE,
      text,
      "text-color": color,
      unit,
      value: meters,
      color,
      width,
      offsetPx,
      points: [p1, p2],
      ties: [tie1, tie2],
    },
  };

  return [ext1, ext2, dimLine, head1, head2, label];
}

/** Build an angular dimension's six features (2 rays, an arc, 2 arrowheads, 1 label). */
function buildAngularDimensionFeatures(
  map: maplibregl.Map,
  p1: Position,
  vertex: Position,
  p3: Position,
  arcRadiusPx: number,
  color: string,
  width: number,
  dimensionId: string,
  tie1: DimensionTie | null,
  tieVertex: DimensionTie | null,
  tie3: DimensionTie | null,
): Feature[] {
  const vpx = map.project(vertex as [number, number]);
  const p1px = map.project(p1 as [number, number]);
  const p3px = map.project(p3 as [number, number]);
  const a1 = Math.atan2(p1px.y - vpx.y, p1px.x - vpx.x);
  const a3 = Math.atan2(p3px.y - vpx.y, p3px.x - vpx.x);
  let delta = a3 - a1;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  const angleDeg = Math.abs(delta) * (180 / Math.PI);
  if (angleDeg < 0.01) return [];

  const arcCoords: Position[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
    const t = a1 + delta * (i / ARC_SEGMENTS);
    arcCoords.push(
      toLngLat(map, vpx.x + Math.cos(t) * arcRadiusPx, vpx.y + Math.sin(t) * arcRadiusPx),
    );
  }

  const lineProps = {
    stroke: color,
    "stroke-width": width,
    "stroke-opacity": 1,
  };
  const rayProps = {
    stroke: color,
    "stroke-width": Math.max(1, width - 1),
    "stroke-opacity": 0.85,
  };
  const text = formatAngle(angleDeg);

  const ray1 = lineStringFeature([vertex, p1], {
    dimensionId,
    __dimension: "angular",
    __dimensionPart: "ray",
    ...rayProps,
  });
  const ray2 = lineStringFeature([vertex, p3], {
    dimensionId,
    __dimension: "angular",
    __dimensionPart: "ray",
    ...rayProps,
  });
  const arc = lineStringFeature(arcCoords, {
    dimensionId,
    __dimension: "angular",
    __dimensionPart: "arc",
    ...lineProps,
  });
  const head1 = arrowheadFeature(map, arcCoords[1] ?? arcCoords[0], arcCoords[0], color);
  const head2 = arrowheadFeature(
    map,
    arcCoords[arcCoords.length - 2] ?? arcCoords[arcCoords.length - 1],
    arcCoords[arcCoords.length - 1],
    color,
  );
  for (const head of [head1, head2]) {
    Object.assign(head.properties as Record<string, unknown>, {
      dimensionId,
      __dimension: "angular",
      __dimensionPart: "head",
    });
  }

  const midT = a1 + delta * 0.5;
  const labelPos = toLngLat(
    map,
    vpx.x + Math.cos(midT) * (arcRadiusPx + LABEL_RADIUS_PADDING_PX),
    vpx.y + Math.sin(midT) * (arcRadiusPx + LABEL_RADIUS_PADDING_PX),
  );
  const label: Feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: labelPos },
    properties: {
      dimensionId,
      __dimension: "angular",
      __dimensionPart: "label",
      shape: TEXT_MARKER_SHAPE,
      text,
      "text-color": color,
      unit: "deg",
      value: angleDeg,
      color,
      width,
      arcRadiusPx,
      points: [p1, vertex, p3],
      ties: [tie1, tieVertex, tie3],
    },
  };

  return [ray1, ray2, arc, head1, head2, label];
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

export { DIMENSIONS_PLUGIN_ID };

let dimensionsPosition: GeoLibreMapControlPosition = "top-left";
let toolbarControl: DimensionToolbarControl | null = null;
let appApi: GeoLibreAppAPI | null = null;
let pluginActive = false;
let activeTool: DimensionTool | null = null;
let strokeColor = DEFAULT_COLOR;
let strokeWidth: number = DEFAULT_WIDTH;
let activeUnit: DimensionUnit = "m";
let snapEnabled = true;
let dimensionLayerId: string | null = null;
let boundMap: maplibregl.Map | null = null;
let storeUnsub: (() => void) | null = null;

// Transient draw state: up to 3 pending points/ties for the tool in progress.
let pendingPoints: Position[] = [];
let pendingTies: (DimensionTie | null)[] = [];

const DIMENSION_ID_PREFIX = Math.random().toString(36).slice(2, 8);
let dimensionCounter = 0;
function nextDimensionId(): string {
  dimensionCounter += 1;
  return `dimension-${DIMENSION_ID_PREFIX}-${dimensionCounter}`;
}

export const maplibreDimensionsPlugin: GeoLibrePlugin = {
  id: DIMENSIONS_PLUGIN_ID,
  name: "Dimensions",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    appApi = app;
    pluginActive = true;

    toolbarControl ??= new DimensionToolbarControl();
    const added = app.addMapControl(toolbarControl, dimensionsPosition);
    if (!added) {
      toolbarControl = null;
      appApi = null;
      pluginActive = false;
      return false;
    }

    const map = app.getMap?.();
    if (map) bindMap(map);
    rediscoverDimensionLayer();
  },
  deactivate: (app: GeoLibreAppAPI) => {
    setActiveTool(null);
    unbindMap();
    if (toolbarControl) {
      app.removeMapControl(toolbarControl);
      toolbarControl = null;
    }
    dimensionLayerId = null;
    pluginActive = false;
    appApi = null;
  },
  getMapControlPosition: () => dimensionsPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    if (!toolbarControl) {
      dimensionsPosition = position;
      return;
    }
    const previousPosition = dimensionsPosition;
    dimensionsPosition = position;
    app.removeMapControl(toolbarControl);
    if (app.addMapControl(toolbarControl, position)) return;
    dimensionsPosition = previousPosition;
    if (!app.addMapControl(toolbarControl, previousPosition)) {
      setActiveTool(null);
      unbindMap();
      dimensionLayerId = null;
      toolbarControl = null;
      pluginActive = false;
      appApi = null;
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface DimensionLabels {
  toolbar: string;
  collapse: string;
  expand: string;
  layerName: string;
  tools: { linear: string; angular: string };
  unit: string;
  snap: string;
  color: string;
  width: string;
  widthOptions: { thin: string; medium: string; thick: string };
  deleteLast: string;
  clearAll: string;
  newLayer: string;
  /** Confirmation prompt before "Clear all dimensions" deletes the layer, given how many dimensions it holds. */
  confirmClearAll: (count: number) => string;
}

let labels: DimensionLabels = {
  toolbar: "Dimension tools",
  collapse: "Collapse dimension tools",
  expand: "Expand dimension tools",
  layerName: DIMENSIONS_LAYER_NAME,
  tools: {
    linear: "Linear dimension",
    angular: "Angular dimension",
  },
  unit: "Unit",
  snap: "Snap to vertices",
  color: "Dimension color",
  width: "Line width",
  widthOptions: { thin: "Thin", medium: "Medium", thick: "Thick" },
  deleteLast: "Delete last dimension",
  clearAll: "Clear all dimensions",
  newLayer: "New dimension layer",
  confirmClearAll: (count) =>
    count === 1
      ? "Delete this dimension? This cannot be undone."
      : `Delete all ${count} dimensions in this layer? This cannot be undone.`,
};

export function setDimensionLabels(next: Partial<DimensionLabels>): void {
  labels = {
    ...labels,
    ...next,
    tools: { ...labels.tools, ...next.tools },
    widthOptions: { ...labels.widthOptions, ...next.widthOptions },
  };
  toolbarControl?.relabel();
}

function widthOptionLabel(value: number): string {
  if (value <= 1) return labels.widthOptions.thin;
  if (value >= 3) return labels.widthOptions.thick;
  return labels.widthOptions.medium;
}

// ---------------------------------------------------------------------------
// Toolbar control
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<DimensionTool, string> = {
  linear:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="9 6 5 12 9 18"/><polyline points="15 6 19 12 15 18"/></svg>',
  angular:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 L4 5"/><path d="M4 20 L19 20"/><path d="M8 20 A8 8 0 0 1 4 13"/></svg>',
};

const SNAP_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15V9a6 6 0 0 1 12 0v6"/><path d="M6 15a3 3 0 0 0 6 0v-4"/><path d="M18 15a3 3 0 0 1-6 0v-4"/></svg>';

const TOOL_ORDER: DimensionTool[] = ["linear", "angular"];

/** A plain-DOM MapLibre control hosting the dimension tools, snap toggle, unit picker, and style inputs. */
class DimensionToolbarControl implements maplibregl.IControl {
  private container: HTMLElement | null = null;
  private toolsContainer: HTMLElement | null = null;
  private collapseButton: HTMLButtonElement | null = null;
  private toolButtons = new Map<DimensionTool, HTMLButtonElement>();
  private snapButton: HTMLButtonElement | null = null;
  private collapsed = false;
  private relabelers: (() => void)[] = [];

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group geolibre-dimensions-control";
    this.relabelers = [() => container.setAttribute("aria-label", labels.toolbar)];

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "geolibre-dimensions-collapse";
    collapseButton.setAttribute("aria-controls", DIMENSION_TOOLS_ID);
    collapseButton.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      if (this.collapsed) setActiveTool(null);
      this.syncCollapsedState();
      this.relabel();
    });
    this.applyLabel(collapseButton, () => (this.collapsed ? labels.expand : labels.collapse));
    container.appendChild(collapseButton);

    const toolsContainer = document.createElement("div");
    toolsContainer.id = DIMENSION_TOOLS_ID;
    toolsContainer.className = "geolibre-dimensions-tools";
    container.appendChild(toolsContainer);

    for (const tool of TOOL_ORDER) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "geolibre-dimensions-tool";
      button.innerHTML = TOOL_ICONS[tool];
      button.addEventListener("click", () => {
        setActiveTool(activeTool === tool ? null : tool);
      });
      this.applyLabel(button, () => labels.tools[tool]);
      this.toolButtons.set(tool, button);
      toolsContainer.appendChild(button);
    }

    const snapButton = document.createElement("button");
    snapButton.type = "button";
    snapButton.className = "geolibre-dimensions-snap";
    snapButton.innerHTML = SNAP_ICON;
    snapButton.classList.toggle("is-active", snapEnabled);
    snapButton.setAttribute("aria-pressed", String(snapEnabled));
    snapButton.addEventListener("click", () => {
      snapEnabled = !snapEnabled;
      snapButton.classList.toggle("is-active", snapEnabled);
      snapButton.setAttribute("aria-pressed", String(snapEnabled));
    });
    this.applyLabel(snapButton, () => labels.snap);
    toolsContainer.appendChild(snapButton);
    this.snapButton = snapButton;

    const unitSelect = document.createElement("select");
    unitSelect.className = "geolibre-dimensions-unit";
    for (const unit of DIMENSION_UNIT_ORDER) {
      const option = document.createElement("option");
      option.value = unit;
      option.textContent = DIMENSION_UNITS[unit].label;
      option.selected = unit === activeUnit;
      unitSelect.appendChild(option);
    }
    unitSelect.addEventListener("change", () => {
      activeUnit = unitSelect.value as DimensionUnit;
    });
    this.applyLabel(unitSelect, () => labels.unit);
    toolsContainer.appendChild(unitSelect);

    const color = document.createElement("input");
    color.type = "color";
    color.className = "geolibre-dimensions-color";
    color.value = strokeColor;
    color.addEventListener("input", () => {
      strokeColor = color.value;
    });
    this.applyLabel(color, () => labels.color);
    toolsContainer.appendChild(color);

    const width = document.createElement("button");
    width.type = "button";
    width.className = "geolibre-dimensions-width";
    const renderWidth = () => {
      const display = strokeWidth <= 1 ? 2 : strokeWidth >= 3 ? 5 : 3;
      width.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="${display}" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>`;
    };
    width.addEventListener("click", () => {
      const values = WIDTH_VALUES as readonly number[];
      const next = values[(values.indexOf(strokeWidth) + 1) % values.length];
      strokeWidth = next ?? DEFAULT_WIDTH;
      renderWidth();
      this.relabel();
    });
    renderWidth();
    this.applyLabel(width, () => `${labels.width}: ${widthOptionLabel(strokeWidth)}`);
    toolsContainer.appendChild(width);

    const newLayer = this.makeActionButton(
      () => labels.newLayer,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
      () => createDimensionLayer(),
    );
    toolsContainer.appendChild(newLayer);

    const deleteLast = this.makeActionButton(
      () => labels.deleteLast,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>',
      () => deleteLastDimension(),
    );
    toolsContainer.appendChild(deleteLast);

    const clearAll = this.makeActionButton(
      () => labels.clearAll,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
      () => clearAllDimensions(),
    );
    toolsContainer.appendChild(clearAll);

    this.container = container;
    this.toolsContainer = toolsContainer;
    this.collapseButton = collapseButton;
    this.syncCollapsedState();
    this.relabel();
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.toolsContainer = null;
    this.collapseButton = null;
    this.snapButton = null;
    this.toolButtons.clear();
    this.relabelers = [];
  }

  relabel(): void {
    for (const relabeler of this.relabelers) relabeler();
  }

  private applyLabel(element: HTMLElement, getLabel: () => string): void {
    this.relabelers.push(() => {
      const label = getLabel();
      element.title = label;
      element.setAttribute("aria-label", label);
    });
  }

  private makeActionButton(
    getLabel: () => string,
    icon: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "geolibre-dimensions-action";
    button.innerHTML = icon;
    button.addEventListener("click", onClick);
    this.applyLabel(button, getLabel);
    return button;
  }

  syncActiveTool(): void {
    for (const [tool, button] of this.toolButtons) {
      button.classList.toggle("is-active", activeTool === tool);
    }
  }

  private syncCollapsedState(): void {
    if (!this.container || !this.toolsContainer || !this.collapseButton) return;
    this.container.classList.toggle("is-collapsed", this.collapsed);
    this.toolsContainer.hidden = this.collapsed;
    this.collapseButton.setAttribute("aria-expanded", String(!this.collapsed));
    this.collapseButton.innerHTML = this.collapsed
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  }
}

// ---------------------------------------------------------------------------
// Tool activation and map binding
// ---------------------------------------------------------------------------

function setActiveTool(tool: DimensionTool | null): void {
  if (activeTool === tool) return;
  resetDrawState();
  if (boundMap) clearPreview(boundMap);
  activeTool = tool;
  toolbarControl?.syncActiveTool();
  if (boundMap) boundMap.getCanvas().style.cursor = tool ? "crosshair" : "";
}

function resetDrawState(): void {
  pendingPoints = [];
  pendingTies = [];
}

function bindMap(map: maplibregl.Map): void {
  if (boundMap === map) return;
  unbindMap();
  boundMap = map;
  map.on("click", handleClick);
  map.on("mousemove", handleMouseMove);
  map.getCanvas().addEventListener("keydown", handleKeyDown, { capture: true });
  storeUnsub = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) recomputeAssociativeDimensions(state.layers);
  });
}

function unbindMap(): void {
  const map = boundMap;
  storeUnsub?.();
  storeUnsub = null;
  resetDrawState();
  if (!map) return;
  map.off("click", handleClick);
  map.off("mousemove", handleMouseMove);
  map.getCanvas().removeEventListener("keydown", handleKeyDown, { capture: true });
  map.getCanvas().style.cursor = "";
  clearPreview(map);
  boundMap = null;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (pendingPoints.length > 0) {
    resetDrawState();
    if (boundMap) clearPreview(boundMap);
    return;
  }
  setActiveTool(null);
}

// ---------------------------------------------------------------------------
// Pointer handlers
// ---------------------------------------------------------------------------

function handleClick(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive || !activeTool) return;
  const map = boundMap;
  if (!map) return;

  const snap = resolveSnap(map, event.point);
  const point: Position = snap
    ? [snap.lngLat.lng, snap.lngLat.lat]
    : [event.lngLat.lng, event.lngLat.lat];
  const tie = snap?.tie ?? null;

  if (activeTool === "linear") {
    handleLinearClick(map, point, tie);
  } else {
    handleAngularClick(map, point, tie);
  }
}

function handleLinearClick(map: maplibregl.Map, point: Position, tie: DimensionTie | null): void {
  if (pendingPoints.length === 0) {
    pendingPoints = [point];
    pendingTies = [tie];
    return;
  }
  if (pendingPoints.length === 1) {
    pendingPoints = [pendingPoints[0], point];
    pendingTies = [pendingTies[0], tie];
    return;
  }
  // Third click: free placement of the dimension line's offset. Its own snap
  // (if the cursor lands near a vertex) is discarded — only its screen
  // position feeds the offset below, no tie is recorded for it.
  const offsetPx = signedPerpendicularOffsetPx(map, pendingPoints[0], pendingPoints[1], point);
  const features = buildLinearDimensionFeatures(
    map,
    pendingPoints[0],
    pendingPoints[1],
    offsetPx,
    activeUnit,
    strokeColor,
    strokeWidth,
    nextDimensionId(),
    pendingTies[0] ?? null,
    pendingTies[1] ?? null,
  );
  appendDimensionFeatures(features);
  resetDrawState();
  clearPreview(map);
}

function handleAngularClick(map: maplibregl.Map, point: Position, tie: DimensionTie | null): void {
  if (pendingPoints.length === 0) {
    pendingPoints = [point];
    pendingTies = [tie];
    return;
  }
  if (pendingPoints.length === 1) {
    pendingPoints = [pendingPoints[0], point];
    pendingTies = [pendingTies[0], tie];
    return;
  }
  const [p1, vertex] = pendingPoints;
  const vpx = map.project(vertex as [number, number]);
  const ppx = map.project(point as [number, number]);
  const arcRadiusPx = Math.max(20, Math.hypot(ppx.x - vpx.x, ppx.y - vpx.y) * 0.6);
  const features = buildAngularDimensionFeatures(
    map,
    p1,
    vertex,
    point,
    arcRadiusPx,
    strokeColor,
    strokeWidth,
    nextDimensionId(),
    pendingTies[0] ?? null,
    pendingTies[1] ?? null,
    tie,
  );
  appendDimensionFeatures(features);
  resetDrawState();
  clearPreview(map);
}

/** Perpendicular screen-pixel offset of `point` from the line p1→p2, signed by which side it falls on. */
function signedPerpendicularOffsetPx(
  map: maplibregl.Map,
  p1: Position,
  p2: Position,
  point: Position,
): number {
  const p1px = map.project(p1 as [number, number]);
  const p2px = map.project(p2 as [number, number]);
  const pointPx = map.project(point as [number, number]);
  const dx = p2px.x - p1px.x;
  const dy = p2px.y - p1px.y;
  const length = Math.hypot(dx, dy) || 1;
  const perpX = -dy / length;
  const perpY = dx / length;
  return (pointPx.x - p1px.x) * perpX + (pointPx.y - p1px.y) * perpY;
}

function handleMouseMove(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive || !activeTool) return;
  const map = boundMap;
  if (!map) return;

  if (pendingPoints.length === 0) {
    clearPreview(map);
    return;
  }

  const cursor: Position = [event.lngLat.lng, event.lngLat.lat];
  const previewId = "preview";

  if (activeTool === "angular") {
    if (pendingPoints.length === 1) {
      setPreview(map, {
        type: "FeatureCollection",
        features: [
          lineStringFeature([pendingPoints[0], cursor], {
            stroke: strokeColor,
            "stroke-width": strokeWidth,
          }),
        ],
      });
      return;
    }
    const [p1, vertex] = pendingPoints;
    const vpx = map.project(vertex as [number, number]);
    const ppx = map.project(cursor as [number, number]);
    const arcRadiusPx = Math.max(20, Math.hypot(ppx.x - vpx.x, ppx.y - vpx.y) * 0.6);
    const features = buildAngularDimensionFeatures(
      map,
      p1,
      vertex,
      cursor,
      arcRadiusPx,
      strokeColor,
      strokeWidth,
      previewId,
      null,
      null,
      null,
    );
    setPreview(map, { type: "FeatureCollection", features });
    return;
  }

  // Linear.
  if (pendingPoints.length === 1) {
    setPreview(map, {
      type: "FeatureCollection",
      features: [
        lineStringFeature([pendingPoints[0], cursor], {
          stroke: strokeColor,
          "stroke-width": strokeWidth,
        }),
      ],
    });
    return;
  }
  const [p1, p2] = pendingPoints;
  const offsetPx = signedPerpendicularOffsetPx(map, p1, p2, cursor);
  const features = buildLinearDimensionFeatures(
    map,
    p1,
    p2,
    offsetPx,
    activeUnit,
    strokeColor,
    strokeWidth,
    previewId,
    null,
    null,
  );
  setPreview(map, { type: "FeatureCollection", features });
}

// ---------------------------------------------------------------------------
// Preview rendering (transient, not persisted)
// ---------------------------------------------------------------------------

function setPreview(map: maplibregl.Map, data: FeatureCollection): void {
  const existing = map.getSource(PREVIEW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return;
  }
  map.addSource(PREVIEW_SOURCE_ID, { type: "geojson", data });
  map.addLayer({
    id: PREVIEW_FILL_LAYER_ID,
    type: "fill",
    source: PREVIEW_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": ["coalesce", ["get", "fill"], strokeColor],
      "fill-opacity": ["coalesce", ["get", "fill-opacity"], 1],
    },
  });
  map.addLayer({
    id: PREVIEW_LINE_LAYER_ID,
    type: "line",
    source: PREVIEW_SOURCE_ID,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": ["coalesce", ["get", "stroke"], strokeColor],
      "line-width": ["coalesce", ["get", "stroke-width"], strokeWidth],
    },
  });
  map.addLayer({
    id: PREVIEW_TEXT_LAYER_ID,
    type: "symbol",
    source: PREVIEW_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "text-field": ["coalesce", ["get", "text"], ""],
      "text-size": 13,
      "text-anchor": "center",
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": ["coalesce", ["get", "text-color"], strokeColor],
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });
}

function clearPreview(map: maplibregl.Map): void {
  if (map.getLayer(PREVIEW_TEXT_LAYER_ID)) map.removeLayer(PREVIEW_TEXT_LAYER_ID);
  if (map.getLayer(PREVIEW_LINE_LAYER_ID)) map.removeLayer(PREVIEW_LINE_LAYER_ID);
  if (map.getLayer(PREVIEW_FILL_LAYER_ID)) map.removeLayer(PREVIEW_FILL_LAYER_ID);
  if (map.getSource(PREVIEW_SOURCE_ID)) map.removeSource(PREVIEW_SOURCE_ID);
}

// ---------------------------------------------------------------------------
// Store integration
// ---------------------------------------------------------------------------

function isDimensionLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === DIMENSIONS_SOURCE_KIND;
}

function findDimensionLayer(layers: GeoLibreLayer[]): GeoLibreLayer | undefined {
  const selectedId = useAppStore.getState().selectedLayerId;
  const selected = layers.find((layer) => layer.id === selectedId);
  if (selected && isDimensionLayer(selected)) {
    dimensionLayerId = selected.id;
    return selected;
  }
  if (dimensionLayerId) {
    const tracked = layers.find((layer) => layer.id === dimensionLayerId);
    if (tracked && isDimensionLayer(tracked)) return tracked;
  }
  return layers.find(isDimensionLayer);
}

function rediscoverDimensionLayer(): void {
  const layer = findDimensionLayer(useAppStore.getState().layers);
  dimensionLayerId = layer?.id ?? null;
}

function appendDimensionFeatures(features: Feature[]): void {
  if (!features.length) return;
  const store = useAppStore.getState();
  const existing = findDimensionLayer(store.layers);
  if (existing) {
    dimensionLayerId = existing.id;
    store.updateLayer(existing.id, {
      geojson: {
        type: "FeatureCollection",
        features: [...(existing.geojson?.features ?? []), ...features],
      },
    });
    return;
  }
  createDimensionLayer(features);
}

function createDimensionLayer(features: Feature[] = []): string {
  const store = useAppStore.getState();
  const id = crypto.randomUUID();
  const names = new Set(store.layers.filter(isDimensionLayer).map((layer) => layer.name));
  let ordinal = 1;
  let name = labels.layerName;
  while (names.has(name)) {
    ordinal += 1;
    name = `${labels.layerName} ${ordinal}`;
  }
  const layer: GeoLibreLayer = {
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, simpleStyleEnabled: true },
    metadata: { sourceKind: DIMENSIONS_SOURCE_KIND },
    geojson: { type: "FeatureCollection", features },
    sourcePath: `${DIMENSIONS_SOURCE_PATH}/${id}`,
  };
  store.addLayer(layer);
  store.selectLayer(id);
  dimensionLayerId = id;
  return id;
}

/** Remove the most recently added dimension (all of its parts, grouped by `dimensionId`). */
function deleteLastDimension(): void {
  const store = useAppStore.getState();
  const layer = findDimensionLayer(store.layers);
  const features = layer?.geojson?.features as Feature[] | undefined;
  if (!layer || !features || features.length === 0) return;

  const last = features[features.length - 1];
  const groupId = (last.properties as Record<string, unknown> | null)?.dimensionId;
  const remaining =
    typeof groupId === "string"
      ? features.filter(
          (feature) =>
            (feature.properties as Record<string, unknown> | null)?.dimensionId !== groupId,
        )
      : features.slice(0, -1);

  if (remaining.length === 0) {
    store.removeLayer(layer.id);
    dimensionLayerId = null;
    return;
  }
  store.updateLayer(layer.id, {
    geojson: { type: "FeatureCollection", features: remaining },
  });
}

/** Distinct dimensions in a Dimensions layer, grouped by `dimensionId`. */
function countDimensionGroups(features: Feature[]): number {
  const ids = new Set<string>();
  for (const feature of features) {
    const id = (feature.properties as Record<string, unknown> | null)?.dimensionId;
    if (typeof id === "string") ids.add(id);
  }
  return ids.size;
}

function clearAllDimensions(): void {
  const store = useAppStore.getState();
  const layer = findDimensionLayer(store.layers);
  if (!layer) return;
  const count = countDimensionGroups((layer.geojson?.features as Feature[] | undefined) ?? []);
  // Nothing to lose: don't prompt over an empty (just-created) layer.
  if (count > 0 && !window.confirm(labels.confirmClearAll(count))) return;
  store.removeLayer(layer.id);
  dimensionLayerId = null;
}

// ---------------------------------------------------------------------------
// Live-associative recompute
// ---------------------------------------------------------------------------

function positionsEqual(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Replace each rebuilt dimension's features in place, at the array position
 * of its first part in `features`, instead of appending rebuilt groups to
 * the end. `deleteLastDimension` (and any other array-position-based
 * reasoning about "most recently created") relies on a dimension's position
 * reflecting creation order, which a recompute must not disturb — the
 * dimension being recomputed is not necessarily the one most recently drawn.
 */
export function spliceRebuiltDimensionGroups(
  features: Feature[],
  rebuiltByGroup: ReadonlyMap<string, Feature[]>,
): Feature[] {
  const emitted = new Set<string>();
  const next: Feature[] = [];
  for (const feature of features) {
    const id = (feature.properties as Record<string, unknown> | null)?.dimensionId;
    if (typeof id === "string" && rebuiltByGroup.has(id)) {
      if (emitted.has(id)) continue;
      emitted.add(id);
      next.push(...rebuiltByGroup.get(id)!);
      continue;
    }
    next.push(feature);
  }
  return next;
}

/**
 * Recompute every dimension whose endpoints are tied to a vertex that has
 * moved. Runs on every store `layers` change (matching the broad subscription
 * Annotations uses for its HTML markers); a dimension with no ties, or whose
 * tied vertices haven't moved, is left untouched and does not write back to
 * the store, so this settles to a fixed point rather than looping.
 */
function recomputeAssociativeDimensions(layers: GeoLibreLayer[]): void {
  const map = boundMap;
  if (!map) return;

  for (const layer of layers) {
    if (!isDimensionLayer(layer) || !layer.geojson) continue;
    const features = layer.geojson.features as Feature[];

    const groups = new Map<string, Feature[]>();
    for (const feature of features) {
      const id = (feature.properties as Record<string, unknown> | null)?.dimensionId;
      if (typeof id !== "string") continue;
      const group = groups.get(id);
      if (group) group.push(feature);
      else groups.set(id, [feature]);
    }

    const rebuiltByGroup = new Map<string, Feature[]>();
    for (const [dimensionId, parts] of groups) {
      const label = parts.find(
        (part) => (part.properties as Record<string, unknown> | null)?.__dimensionPart === "label",
      );
      if (!label) continue;
      const props = label.properties as Record<string, unknown> | undefined;
      const parsed = parseAssociativeDimension(props);
      if (!parsed) continue;
      const { kind, points, ties } = parsed;

      const resolved = points.map((point, index) => {
        const tie = ties[index];
        if (!tie) return point;
        return resolveTiePosition(tie, layers) ?? point;
      });
      if (resolved.every((point, index) => positionsEqual(point, points[index]))) continue;

      const color = (props!.color as string) ?? strokeColor;
      const width = (props!.width as number) ?? strokeWidth;
      const unit = (props!.unit as DimensionUnit) ?? activeUnit;
      const rebuilt =
        kind === "angular"
          ? buildAngularDimensionFeatures(
              map,
              resolved[0],
              resolved[1],
              resolved[2],
              (props!.arcRadiusPx as number) ?? 40,
              color,
              width,
              dimensionId,
              ties[0] ?? null,
              ties[1] ?? null,
              ties[2] ?? null,
            )
          : buildLinearDimensionFeatures(
              map,
              resolved[0],
              resolved[1],
              (props!.offsetPx as number) ?? 0,
              unit,
              color,
              width,
              dimensionId,
              ties[0] ?? null,
              ties[1] ?? null,
            );
      if (rebuilt.length) rebuiltByGroup.set(dimensionId, rebuilt);
    }

    if (rebuiltByGroup.size === 0) continue;
    const nextFeatures = spliceRebuiltDimensionGroups(features, rebuiltByGroup);
    useAppStore.getState().updateLayer(layer.id, {
      geojson: { type: "FeatureCollection", features: nextFeatures },
    });
  }
}
