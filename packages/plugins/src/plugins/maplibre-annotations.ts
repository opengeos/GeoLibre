import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { Feature, FeatureCollection, Position } from "geojson";
import type maplibregl from "maplibre-gl";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

/**
 * Annotation layer plugin: lightweight cartographic decoration (free text,
 * arrows, and highlight shapes) drawn directly on the map and stored in the
 * project. Unlike the GeoEditor plugin (which edits real geographic features
 * through Geoman), annotations are decoration: they reuse none of Geoman's
 * editing engine. Instead this plugin draws with plain MapLibre interactions
 * and writes the result into a single tagged GeoJSON layer, so it renders
 * through the standard layer-sync path (and is therefore captured by the Print
 * layout and persisted in `.geolibre.json`) with no special rendering code.
 *
 * Annotation features carry simplestyle-spec properties (`stroke`, `fill`,
 * `stroke-width`, `fill-opacity`) so each shape keeps its own color/width via
 * the layer-sync simplestyle path, and text uses the `text_marker` shape
 * convention the geojson symbol layer already understands.
 */

export const ANNOTATIONS_SOURCE_KIND = "annotation";
const ANNOTATIONS_LAYER_NAME = "Annotations";
const ANNOTATIONS_SOURCE_PATH = "annotations://layer";

// Shared with the layer-sync text-marker rendering: a point with this shape and
// a `text` property is drawn as a label rather than a circle.
const TEXT_MARKER_SHAPE = "text_marker";

const PREVIEW_SOURCE_ID = "geolibre-annotation-preview";
const PREVIEW_FILL_LAYER_ID = "geolibre-annotation-preview-fill";
const PREVIEW_LINE_LAYER_ID = "geolibre-annotation-preview-line";

const DEFAULT_COLOR = "#ef4444";
const DEFAULT_WIDTH = 3;
const FILL_OPACITY = 0.25;
const ELLIPSE_SEGMENTS = 72;
// Arrowhead size in screen pixels, converted to geographic coordinates at draw
// time so the head matches the shaft at the zoom it was drawn.
const ARROWHEAD_LENGTH_PX = 16;
const ARROWHEAD_HALF_WIDTH_PX = 8;

type AnnotationTool =
  | "text"
  | "arrow"
  | "rectangle"
  | "ellipse"
  | "freehand";

// State is module-scope, so this plugin is a single-instance singleton (one
// shared toolbar/editor across the app), matching the GeoEditor plugin. That is
// fine for the single-map desktop/web/embed builds; it would need per-instance
// state to support several independent maps on one page (e.g. a multi-cell
// notebook), which is not a target for this first version.
let annotationsPosition: GeoLibreMapControlPosition = "top-left";
let toolbarControl: AnnotationToolbarControl | null = null;
let appApi: GeoLibreAppAPI | null = null;
let pluginActive = false;
let activeTool: AnnotationTool | null = null;
let strokeColor = DEFAULT_COLOR;
let strokeWidth = DEFAULT_WIDTH;
let annotationLayerId: string | null = null;

// Transient draw state.
let boundMap: maplibregl.Map | null = null;
let arrowStart: maplibregl.LngLat | null = null;
let dragStart: maplibregl.LngLat | null = null;
let freehandPath: Position[] = [];
let isDragging = false;
let activeTextInput: HTMLInputElement | null = null;
// Idempotent finisher for the open text input (commits or discards once).
let finishTextInput: ((save: boolean) => void) | null = null;

export const maplibreAnnotationsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-annotations",
  name: "Annotations",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    appApi = app;
    pluginActive = true;

    toolbarControl ??= new AnnotationToolbarControl();
    const added = app.addMapControl(toolbarControl, annotationsPosition);
    if (!added) {
      toolbarControl = null;
      appApi = null;
      pluginActive = false;
      return false;
    }

    const map = app.getMap?.();
    if (map) bindMap(map);
    rediscoverAnnotationLayer();
  },
  deactivate: (app: GeoLibreAppAPI) => {
    setActiveTool(null);
    cancelTextInput();
    unbindMap();
    if (toolbarControl) {
      app.removeMapControl(toolbarControl);
      toolbarControl = null;
    }
    // Drop the tracked layer id so a later activation (e.g. after opening a new
    // project) re-discovers from scratch rather than trusting a stale id.
    annotationLayerId = null;
    pluginActive = false;
    appApi = null;
  },
  getMapControlPosition: () => annotationsPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    if (!toolbarControl) {
      annotationsPosition = position;
      return;
    }
    const previousPosition = annotationsPosition;
    annotationsPosition = position;
    app.removeMapControl(toolbarControl);
    if (app.addMapControl(toolbarControl, position)) return;
    // Re-adding at the new corner failed; restore the previous position so the
    // toolbar does not vanish and the stored position stays consistent.
    annotationsPosition = previousPosition;
    if (!app.addMapControl(toolbarControl, previousPosition)) {
      // Both re-adds failed: the control is no longer on the map, so drop the
      // reference and deactivate so the plugin's state matches reality.
      toolbarControl = null;
      pluginActive = false;
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// Toolbar control
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<AnnotationTool, string> = {
  text: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="11 5 19 5 19 13"/></svg>',
  rectangle:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
  ellipse:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="9" ry="6"/></svg>',
  freehand:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-6 6-9 9-9s2 5 4 5 2-3 5-3"/></svg>',
};

const TOOL_ORDER: AnnotationTool[] = [
  "text",
  "arrow",
  "rectangle",
  "ellipse",
  "freehand",
];

const WIDTH_VALUES = [2, 3, 5] as const;

/**
 * User-facing strings the toolbar cannot translate itself. Defaults are
 * English; the desktop shell pushes translated values via
 * {@link setAnnotationLabels}, mirroring the other framework-agnostic plugins
 * (e.g. {@link setBasemapControlLabels}) since this package has no direct
 * access to react-i18next.
 */
export interface AnnotationLabels {
  toolbar: string;
  tools: Record<AnnotationTool, string>;
  color: string;
  width: string;
  widthOptions: { thin: string; medium: string; thick: string };
  deleteLast: string;
  clearAll: string;
  textPlaceholder: string;
}

let labels: AnnotationLabels = {
  toolbar: "Annotation tools",
  tools: {
    text: "Text",
    arrow: "Arrow",
    rectangle: "Rectangle highlight",
    ellipse: "Ellipse highlight",
    freehand: "Freehand highlight",
  },
  color: "Annotation color",
  width: "Line width",
  widthOptions: { thin: "Thin", medium: "Medium", thick: "Thick" },
  deleteLast: "Delete last annotation",
  clearAll: "Clear all annotations",
  textPlaceholder: "Type label, Enter to place",
};

/** Override the toolbar strings (called from the app layer with translated text). */
export function setAnnotationLabels(next: Partial<AnnotationLabels>): void {
  labels = { ...labels, ...next };
}

function widthOptionLabel(value: number): string {
  if (value <= 2) return labels.widthOptions.thin;
  if (value >= 5) return labels.widthOptions.thick;
  return labels.widthOptions.medium;
}

/** A plain-DOM MapLibre control hosting the annotation tools and style inputs. */
class AnnotationToolbarControl implements maplibregl.IControl {
  private container: HTMLElement | null = null;
  private toolButtons = new Map<AnnotationTool, HTMLButtonElement>();

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group geolibre-annotations-control";
    container.setAttribute("aria-label", labels.toolbar);

    for (const tool of TOOL_ORDER) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "geolibre-annotations-tool";
      button.title = labels.tools[tool];
      button.setAttribute("aria-label", labels.tools[tool]);
      button.innerHTML = TOOL_ICONS[tool];
      button.addEventListener("click", () => {
        setActiveTool(activeTool === tool ? null : tool);
      });
      this.toolButtons.set(tool, button);
      container.appendChild(button);
    }

    const color = document.createElement("input");
    color.type = "color";
    color.className = "geolibre-annotations-color";
    color.value = strokeColor;
    color.title = labels.color;
    color.setAttribute("aria-label", labels.color);
    color.addEventListener("input", () => {
      strokeColor = color.value;
    });
    container.appendChild(color);

    const width = document.createElement("select");
    width.className = "geolibre-annotations-width";
    width.title = labels.width;
    width.setAttribute("aria-label", labels.width);
    for (const value of WIDTH_VALUES) {
      const opt = document.createElement("option");
      opt.value = String(value);
      opt.textContent = widthOptionLabel(value);
      if (value === strokeWidth) opt.selected = true;
      width.appendChild(opt);
    }
    width.addEventListener("change", () => {
      strokeWidth = Number(width.value) || DEFAULT_WIDTH;
    });
    container.appendChild(width);

    const deleteLast = this.makeActionButton(
      labels.deleteLast,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>',
      () => deleteLastAnnotation(),
    );
    container.appendChild(deleteLast);

    const clearAll = this.makeActionButton(
      labels.clearAll,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
      () => clearAllAnnotations(),
    );
    container.appendChild(clearAll);

    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.toolButtons.clear();
  }

  private makeActionButton(
    label: string,
    icon: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "geolibre-annotations-action";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
    button.addEventListener("click", onClick);
    return button;
  }

  /** Reflect the active tool in the toolbar's button styling. */
  syncActiveTool(): void {
    for (const [tool, button] of this.toolButtons) {
      button.classList.toggle("is-active", activeTool === tool);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool activation and map binding
// ---------------------------------------------------------------------------

function setActiveTool(tool: AnnotationTool | null): void {
  if (activeTool === tool) return;
  resetDrawState();
  // Drop any in-progress preview (e.g. an arrow whose start point was placed)
  // so it does not hang on the map after switching tools.
  if (boundMap) clearPreview(boundMap);
  activeTool = tool;
  toolbarControl?.syncActiveTool();

  const map = boundMap;
  if (!map) return;
  // Drag-based tools (rectangle/ellipse/freehand) own the pointer, so suspend
  // map panning while one is active and restore it otherwise.
  const dragTool =
    tool === "rectangle" || tool === "ellipse" || tool === "freehand";
  if (dragTool) {
    map.dragPan.disable();
  } else {
    map.dragPan.enable();
  }
  map.getCanvas().style.cursor = tool ? "crosshair" : "";
}

function bindMap(map: maplibregl.Map): void {
  if (boundMap === map) return;
  unbindMap();
  boundMap = map;
  map.on("click", handleClick);
  map.on("mousedown", handleMouseDown);
  map.on("mousemove", handleMouseMove);
  map.on("mouseup", handleMouseUp);
  // Scope Escape to the map canvas (capture, ahead of MapLibre's own handler)
  // rather than the document, so pressing Escape in an unrelated input (layer
  // name field, search box, attribute cell) cannot cancel an annotation tool.
  map.getCanvas().addEventListener("keydown", handleKeyDown, { capture: true });
}

function unbindMap(): void {
  const map = boundMap;
  if (!map) return;
  map.off("click", handleClick);
  map.off("mousedown", handleMouseDown);
  map.off("mousemove", handleMouseMove);
  map.off("mouseup", handleMouseUp);
  map.getCanvas().removeEventListener("keydown", handleKeyDown, {
    capture: true,
  });
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  clearPreview(map);
  boundMap = null;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (activeTextInput) {
    cancelTextInput();
    return;
  }
  if (arrowStart || isDragging) {
    resetDrawState();
    if (boundMap) clearPreview(boundMap);
    return;
  }
  setActiveTool(null);
}

function resetDrawState(): void {
  arrowStart = null;
  dragStart = null;
  freehandPath = [];
  isDragging = false;
}

// ---------------------------------------------------------------------------
// Pointer handlers
// ---------------------------------------------------------------------------

function handleClick(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive) return;
  if (activeTool === "text") {
    openTextInput(event);
    return;
  }
  if (activeTool === "arrow") {
    handleArrowClick(event);
    return;
  }
}

function handleArrowClick(event: maplibregl.MapMouseEvent): void {
  const map = boundMap;
  if (!map) return;
  if (!arrowStart) {
    arrowStart = event.lngLat;
    return;
  }
  const features = buildArrow(map, arrowStart, event.lngLat);
  arrowStart = null;
  clearPreview(map);
  if (features.length) appendAnnotationFeatures(features);
}

function handleMouseDown(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive) return;
  if (
    activeTool !== "rectangle" &&
    activeTool !== "ellipse" &&
    activeTool !== "freehand"
  ) {
    return;
  }
  // Suppress the map's own drag-to-pan for this gesture.
  event.preventDefault();
  isDragging = true;
  dragStart = event.lngLat;
  freehandPath = [[event.lngLat.lng, event.lngLat.lat]];
}

function handleMouseMove(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive) return;
  const map = boundMap;
  if (!map) return;

  if (activeTool === "arrow" && arrowStart) {
    setPreview(map, {
      type: "FeatureCollection",
      features: [lineFeature([toPos(arrowStart), toPos(event.lngLat)])],
    });
    return;
  }

  if (!isDragging || !dragStart) return;

  if (activeTool === "rectangle") {
    setPreview(map, polygonPreview(rectangleRing(dragStart, event.lngLat)));
  } else if (activeTool === "ellipse") {
    setPreview(map, polygonPreview(ellipseRing(dragStart, event.lngLat)));
  } else if (activeTool === "freehand") {
    freehandPath.push([event.lngLat.lng, event.lngLat.lat]);
    setPreview(map, {
      type: "FeatureCollection",
      features: [lineFeature(freehandPath)],
    });
  }
}

function handleMouseUp(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive || !isDragging) return;
  const map = boundMap;
  isDragging = false;
  if (!map || !dragStart) {
    resetDrawState();
    return;
  }

  let ring: Position[] | null = null;
  if (activeTool === "rectangle") {
    ring = rectangleRing(dragStart, event.lngLat);
  } else if (activeTool === "ellipse") {
    ring = ellipseRing(dragStart, event.lngLat);
  } else if (activeTool === "freehand") {
    freehandPath.push([event.lngLat.lng, event.lngLat.lat]);
    ring = closeRing(freehandPath);
  }

  dragStart = null;
  freehandPath = [];
  clearPreview(map);

  if (ring && ring.length >= 4 && !degenerateRing(ring)) {
    appendAnnotationFeatures([polygonFeature(ring)]);
  }
}

// ---------------------------------------------------------------------------
// Text input overlay
// ---------------------------------------------------------------------------

function openTextInput(event: maplibregl.MapMouseEvent): void {
  const map = boundMap;
  if (!map) return;
  cancelTextInput();

  const lngLat = event.lngLat;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "geolibre-annotation-text-input";
  input.placeholder = labels.textPlaceholder;
  input.style.position = "absolute";
  input.style.left = `${event.point.x}px`;
  input.style.top = `${event.point.y}px`;
  input.style.zIndex = "5";

  // Enter/blur commit and Escape discards; each removes the input, which fires
  // `blur` again, so route everything through one idempotent finisher that adds
  // the feature (or not) and removes the node exactly once. Committing on blur
  // (rather than discarding) is deliberate: a click elsewhere on the map places
  // the typed label instead of silently losing it; an empty input adds nothing.
  let done = false;
  const onBlur = () => finish(true);
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.removeEventListener("blur", onBlur);
    input.remove();
    if (activeTextInput === input) {
      activeTextInput = null;
      finishTextInput = null;
    }
    if (save && value) appendAnnotationFeatures([textFeature(lngLat, value)]);
  };

  input.addEventListener("keydown", (keyEvent) => {
    keyEvent.stopPropagation();
    if (keyEvent.key === "Enter") {
      keyEvent.preventDefault();
      finish(true);
    } else if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", onBlur);

  map.getCanvasContainer().appendChild(input);
  activeTextInput = input;
  finishTextInput = finish;
  // Focus after the click settles so the input keeps focus.
  window.setTimeout(() => input.focus(), 0);
}

function cancelTextInput(): void {
  finishTextInput?.(false);
}

// ---------------------------------------------------------------------------
// Feature builders
// ---------------------------------------------------------------------------

function toPos(lngLat: maplibregl.LngLat): Position {
  return [lngLat.lng, lngLat.lat];
}

function strokeProps(): Record<string, unknown> {
  return {
    stroke: strokeColor,
    "stroke-width": strokeWidth,
    "stroke-opacity": 1,
  };
}

function fillProps(): Record<string, unknown> {
  return {
    ...strokeProps(),
    fill: strokeColor,
    "fill-opacity": FILL_OPACITY,
  };
}

function lineFeature(coordinates: Position[]): Feature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: { __annotation: "line", ...strokeProps() },
  };
}

function polygonFeature(ring: Position[]): Feature {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ensureCcwRing(ring)] },
    properties: { __annotation: "highlight", ...fillProps() },
  };
}

function textFeature(lngLat: maplibregl.LngLat, text: string): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: toPos(lngLat) },
    properties: { __annotation: "text", shape: TEXT_MARKER_SHAPE, text },
  };
}

/**
 * Build the two features of an arrow: the shaft (a line) and a filled triangle
 * arrowhead at the end. The head is sized in screen pixels at the current zoom
 * and filled with the shaft color so the two read as one arrow.
 */
function buildArrow(
  map: maplibregl.Map,
  start: maplibregl.LngLat,
  end: maplibregl.LngLat,
): Feature[] {
  const startPx = map.project(start);
  const endPx = map.project(end);
  const dx = endPx.x - startPx.x;
  const dy = endPx.y - startPx.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) return [];

  const shaft = lineFeature([toPos(start), toPos(end)]);
  const annotationId = nextAnnotationId();
  (shaft.properties as Record<string, unknown>).annotationId = annotationId;

  const ux = dx / length;
  const uy = dy / length;
  // Perpendicular unit vector.
  const px = -uy;
  const py = ux;
  const baseX = endPx.x - ux * ARROWHEAD_LENGTH_PX;
  const baseY = endPx.y - uy * ARROWHEAD_LENGTH_PX;
  const leftPx = { x: baseX + px * ARROWHEAD_HALF_WIDTH_PX, y: baseY + py * ARROWHEAD_HALF_WIDTH_PX };
  const rightPx = { x: baseX - px * ARROWHEAD_HALF_WIDTH_PX, y: baseY - py * ARROWHEAD_HALF_WIDTH_PX };

  const tip = toPos(end);
  const left = toPos(map.unproject([leftPx.x, leftPx.y]));
  const right = toPos(map.unproject([rightPx.x, rightPx.y]));
  const head: Feature = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [ensureCcwRing([tip, left, right, tip])],
    },
    properties: {
      __annotation: "arrowhead",
      annotationId,
      fill: strokeColor,
      "fill-opacity": 1,
      stroke: strokeColor,
      "stroke-width": 1,
    },
  };

  return [shaft, head];
}

// A per-load random prefix so ids minted this session cannot collide with ids
// already saved in a reopened project (the counter restarts at 0 each load, so
// a bare `annotation-N` would clash and make "Delete last" drop a saved arrow).
const ANNOTATION_ID_PREFIX = Math.random().toString(36).slice(2, 8);
let annotationCounter = 0;
/** A session-unique id grouping the parts of one annotation (e.g. arrow + head). */
function nextAnnotationId(): string {
  annotationCounter += 1;
  return `annotation-${ANNOTATION_ID_PREFIX}-${annotationCounter}`;
}

function rectangleRing(a: maplibregl.LngLat, b: maplibregl.LngLat): Position[] {
  return [
    [a.lng, a.lat],
    [b.lng, a.lat],
    [b.lng, b.lat],
    [a.lng, b.lat],
    [a.lng, a.lat],
  ];
}

function ellipseRing(a: maplibregl.LngLat, b: maplibregl.LngLat): Position[] {
  const cx = (a.lng + b.lng) / 2;
  const cy = (a.lat + b.lat) / 2;
  const rx = Math.abs(b.lng - a.lng) / 2;
  const ry = Math.abs(b.lat - a.lat) / 2;
  const ring: Position[] = [];
  for (let i = 0; i <= ELLIPSE_SEGMENTS; i += 1) {
    const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
    ring.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return ring;
}

function closeRing(path: Position[]): Position[] {
  if (path.length < 3) return path;
  const first = path[0];
  const last = path[path.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return path;
  return [...path, first];
}

/**
 * A drag that is flat in either dimension produces an invisible zero-area
 * polygon (e.g. a purely horizontal rectangle drag), so reject a ring whose
 * bounding box collapses in width OR height, not only when both collapse.
 */
function degenerateRing(ring: Position[]): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX - minX < 1e-9 || maxY - minY < 1e-9;
}

/**
 * Normalize a closed ring to counterclockwise winding (RFC 7946 §3.1.6 for a
 * polygon exterior ring), so annotations round-trip through strict GeoJSON
 * validators and winding-sensitive tools (e.g. Turf) regardless of the
 * direction the user dragged or aimed an arrow.
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

// ---------------------------------------------------------------------------
// Preview rendering (transient, not persisted)
// ---------------------------------------------------------------------------

function polygonPreview(ring: Position[]): FeatureCollection {
  return { type: "FeatureCollection", features: [polygonFeature(ring)] };
}

function setPreview(map: maplibregl.Map, data: FeatureCollection): void {
  const existing = map.getSource(PREVIEW_SOURCE_ID) as
    | maplibregl.GeoJSONSource
    | undefined;
  if (existing) {
    existing.setData(data);
    // Repaint too, so changing the color/width between an arrow's two clicks is
    // reflected in the live preview rather than only in the committed feature.
    map.setPaintProperty(PREVIEW_FILL_LAYER_ID, "fill-color", strokeColor);
    map.setPaintProperty(PREVIEW_LINE_LAYER_ID, "line-color", strokeColor);
    map.setPaintProperty(PREVIEW_LINE_LAYER_ID, "line-width", strokeWidth);
    return;
  }
  map.addSource(PREVIEW_SOURCE_ID, { type: "geojson", data });
  map.addLayer({
    id: PREVIEW_FILL_LAYER_ID,
    type: "fill",
    source: PREVIEW_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": strokeColor, "fill-opacity": FILL_OPACITY },
  });
  map.addLayer({
    id: PREVIEW_LINE_LAYER_ID,
    type: "line",
    source: PREVIEW_SOURCE_ID,
    paint: {
      "line-color": strokeColor,
      "line-width": strokeWidth,
      "line-dasharray": [2, 1],
    },
  });
}

function clearPreview(map: maplibregl.Map): void {
  if (map.getLayer(PREVIEW_LINE_LAYER_ID)) map.removeLayer(PREVIEW_LINE_LAYER_ID);
  if (map.getLayer(PREVIEW_FILL_LAYER_ID)) map.removeLayer(PREVIEW_FILL_LAYER_ID);
  if (map.getSource(PREVIEW_SOURCE_ID)) map.removeSource(PREVIEW_SOURCE_ID);
}

// ---------------------------------------------------------------------------
// Store integration
// ---------------------------------------------------------------------------

function isAnnotationLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === ANNOTATIONS_SOURCE_KIND;
}

function findAnnotationLayer(
  layers: GeoLibreLayer[],
): GeoLibreLayer | undefined {
  if (annotationLayerId) {
    const tracked = layers.find((layer) => layer.id === annotationLayerId);
    // Verify the tracked layer is still an annotation layer: after a project
    // reload `annotationLayerId` may be stale and (however unlikely) collide
    // with an unrelated layer's id until `rediscoverAnnotationLayer` runs.
    if (tracked && isAnnotationLayer(tracked)) return tracked;
  }
  return layers.find(isAnnotationLayer);
}

/** Locate an existing annotation layer (e.g. after reopening a project). */
function rediscoverAnnotationLayer(): void {
  const layer = findAnnotationLayer(useAppStore.getState().layers);
  annotationLayerId = layer?.id ?? null;
}

function appendAnnotationFeatures(features: Feature[]): void {
  if (!features.length) return;
  const store = useAppStore.getState();
  const existing = findAnnotationLayer(store.layers);
  const hasText = features.some(
    (feature) =>
      (feature.properties as Record<string, unknown> | null)?.shape ===
      TEXT_MARKER_SHAPE,
  );

  if (existing) {
    annotationLayerId = existing.id;
    const next: FeatureCollection = {
      type: "FeatureCollection",
      features: [...(existing.geojson?.features ?? []), ...features],
    };
    store.updateLayer(existing.id, { geojson: next });
    // Label color is layer-level (the text_marker symbol layer reads
    // layer.style.textColor, not a per-feature property), so apply the toolbar
    // color whenever text is placed. Shapes/arrows carry per-feature color; text
    // shares one layer color, latest-wins (per-label color is a follow-up).
    if (hasText) store.setLayerStyle(existing.id, { textColor: strokeColor });
    return;
  }

  // Build the layer fully and add it in a single store mutation, so it never
  // appears with `sourceKind`/`simpleStyleEnabled` unset (which would briefly
  // render the first annotation without its per-feature colors).
  const id = crypto.randomUUID();
  const layer: GeoLibreLayer = {
    id,
    name: ANNOTATIONS_LAYER_NAME,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      // Force the simplestyle path on so per-feature stroke/fill always apply,
      // even when the first annotation is text (which carries no simplestyle).
      simpleStyleEnabled: true,
      ...(hasText ? { textColor: strokeColor } : {}),
    },
    metadata: { sourceKind: ANNOTATIONS_SOURCE_KIND },
    geojson: { type: "FeatureCollection", features },
    sourcePath: ANNOTATIONS_SOURCE_PATH,
  };
  store.addLayer(layer);
  annotationLayerId = id;
}

/** Remove the most recently added annotation (and its arrowhead, if any). */
function deleteLastAnnotation(): void {
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  const features = layer?.geojson?.features;
  if (!layer || !features || features.length === 0) return;

  const last = features[features.length - 1];
  const groupId = (last.properties as Record<string, unknown> | null)
    ?.annotationId;
  let remaining: Feature[];
  if (typeof groupId === "string") {
    remaining = features.filter(
      (feature) =>
        (feature.properties as Record<string, unknown> | null)
          ?.annotationId !== groupId,
    );
  } else {
    remaining = features.slice(0, -1);
  }

  if (remaining.length === 0) {
    store.removeLayer(layer.id);
    annotationLayerId = null;
    return;
  }
  store.updateLayer(layer.id, {
    geojson: { type: "FeatureCollection", features: remaining },
  });
}

/** Remove the whole annotation layer. */
function clearAllAnnotations(): void {
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  if (!layer) return;
  store.removeLayer(layer.id);
  annotationLayerId = null;
}
