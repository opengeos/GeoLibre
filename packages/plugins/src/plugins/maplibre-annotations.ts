import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection, Position } from "geojson";
import type maplibregl from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

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

type AnnotationTool = "text" | "arrow" | "rectangle" | "ellipse" | "freehand";

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
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
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
      // Both re-adds failed: the control is gone from the map, so run the same
      // teardown as deactivate() (drop draw handlers, cursor, drag-pan, text
      // input, tracked layer) instead of leaving the plugin half-active.
      setActiveTool(null);
      cancelTextInput();
      unbindMap();
      annotationLayerId = null;
      toolbarControl = null;
      pluginActive = false;
      appApi = null;
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

const TOOL_ORDER: AnnotationTool[] = ["text", "arrow", "rectangle", "ellipse", "freehand"];

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
  /** Name of the layer the annotations are stored in (shown in the Layers panel). */
  layerName: string;
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
  layerName: ANNOTATIONS_LAYER_NAME,
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

/**
 * Override the toolbar strings (called from the app layer with translated
 * text). Merges one level deep so a caller may pass a partial `tools` or
 * `widthOptions` without dropping the other nested entries, and relabels an
 * already-mounted toolbar so a runtime language change is reflected immediately.
 */
export function setAnnotationLabels(next: Partial<AnnotationLabels>): void {
  labels = {
    ...labels,
    ...next,
    tools: { ...labels.tools, ...next.tools },
    widthOptions: { ...labels.widthOptions, ...next.widthOptions },
  };
  toolbarControl?.relabel();
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
  // Closures that re-apply each element's translated text from `labels`, run on
  // mount and again whenever the active language changes (see relabel()).
  private relabelers: (() => void)[] = [];

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group geolibre-annotations-control";
    this.relabelers = [() => container.setAttribute("aria-label", labels.toolbar)];

    for (const tool of TOOL_ORDER) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "geolibre-annotations-tool";
      button.innerHTML = TOOL_ICONS[tool];
      button.addEventListener("click", () => {
        setActiveTool(activeTool === tool ? null : tool);
      });
      this.applyLabel(button, () => labels.tools[tool]);
      this.toolButtons.set(tool, button);
      container.appendChild(button);
    }

    const color = document.createElement("input");
    color.type = "color";
    color.className = "geolibre-annotations-color";
    color.value = strokeColor;
    color.addEventListener("input", () => {
      strokeColor = color.value;
    });
    this.applyLabel(color, () => labels.color);
    container.appendChild(color);

    // A cycling button (thin → medium → thick) rather than a native <select>:
    // the icon uses currentColor so it themes with the other tools, and there is
    // no native dropdown popup to theme (which is unreliable in a dark, narrow
    // toolbar). The line in the icon thickens with the selected width.
    const width = document.createElement("button");
    width.type = "button";
    width.className = "geolibre-annotations-width";
    const renderWidth = () => {
      const display = strokeWidth <= 2 ? 2 : strokeWidth >= 5 ? 6 : 4;
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
    container.appendChild(width);

    const deleteLast = this.makeActionButton(
      () => labels.deleteLast,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>',
      () => deleteLastAnnotation(),
    );
    container.appendChild(deleteLast);

    const clearAll = this.makeActionButton(
      () => labels.clearAll,
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
      () => clearAllAnnotations(),
    );
    container.appendChild(clearAll);

    this.container = container;
    this.relabel();
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.toolButtons.clear();
    this.relabelers = [];
  }

  /** Re-apply all translated strings (called on mount and on language change). */
  relabel(): void {
    for (const relabeler of this.relabelers) relabeler();
  }

  /** Point an element's title/aria-label at a label getter and track it for relabel. */
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
    button.className = "geolibre-annotations-action";
    button.innerHTML = icon;
    button.addEventListener("click", onClick);
    this.applyLabel(button, getLabel);
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
  const dragTool = tool === "rectangle" || tool === "ellipse" || tool === "freehand";
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
  // A map "mouseup" only fires over the canvas; if a drag is released outside
  // it, this window fallback still ends the gesture so isDragging/drag-pan do
  // not stay stuck and the preview does not linger.
  window.addEventListener("mouseup", handleWindowMouseUp);
  // Scope Escape to the map canvas (capture, ahead of MapLibre's own handler)
  // rather than the document, so pressing Escape in an unrelated input (layer
  // name field, search box, attribute cell) cannot cancel an annotation tool.
  map.getCanvas().addEventListener("keydown", handleKeyDown, { capture: true });
}

/** End a drag released outside the canvas: discard the in-progress shape. */
function handleWindowMouseUp(): void {
  if (!isDragging) return;
  isDragging = false;
  dragStart = null;
  freehandPath = [];
  if (boundMap) clearPreview(boundMap);
}

function unbindMap(): void {
  const map = boundMap;
  if (!map) return;
  map.off("click", handleClick);
  map.off("mousedown", handleMouseDown);
  map.off("mousemove", handleMouseMove);
  map.off("mouseup", handleMouseUp);
  window.removeEventListener("mouseup", handleWindowMouseUp);
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
  if (activeTool !== "rectangle" && activeTool !== "ellipse" && activeTool !== "freehand") {
    return;
  }
  // Only a primary (left) press starts a shape; mousedown fires for every
  // button, so a right-click would otherwise begin an accidental drag.
  if (event.originalEvent.button !== 0) return;
  // Map drag-to-pan is already disabled by setActiveTool() for these tools, so
  // nothing else is needed to keep the gesture from panning the map.
  isDragging = true;
  dragStart = event.lngLat;
  freehandPath = [[event.lngLat.lng, event.lngLat.lat]];
}

function handleMouseMove(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive) return;
  const map = boundMap;
  if (!map) return;

  if (activeTool === "arrow" && arrowStart) {
    // Preview the shaft and a provisional arrowhead so the head's size and
    // direction are visible before the second click commits the arrow.
    setPreview(map, {
      type: "FeatureCollection",
      features: arrowFeatures(map, arrowStart, event.lngLat),
    });
    return;
  }

  if (!isDragging || !dragStart) return;

  if (activeTool === "rectangle") {
    setPreview(map, polygonPreview(rectangleRing(dragStart, event.lngLat)));
  } else if (activeTool === "ellipse") {
    setPreview(map, polygonPreview(ellipseRing(dragStart, event.lngLat)));
  } else if (activeTool === "freehand") {
    // Sample sparsely: only keep a point once the cursor has moved a few pixels
    // from the last, so a long stroke does not accumulate thousands of vertices.
    if (movedEnoughForFreehand(map, event.lngLat)) {
      freehandPath.push([event.lngLat.lng, event.lngLat.lat]);
    }
    // A LineString needs at least two positions; the path holds only the seed
    // point until the cursor first moves past the sampling threshold.
    if (freehandPath.length >= 2) {
      setPreview(map, {
        type: "FeatureCollection",
        features: [lineFeature(freehandPath)],
      });
    }
  }
}

const FREEHAND_MIN_PIXELS = 4;

/** True when the cursor has moved at least the sampling threshold from the last point. */
function movedEnoughForFreehand(map: maplibregl.Map, lngLat: maplibregl.LngLat): boolean {
  const last = freehandPath[freehandPath.length - 1];
  if (!last) return true;
  const a = map.project(lngLat);
  const b = map.project({ lng: last[0], lat: last[1] });
  return Math.hypot(a.x - b.x, a.y - b.y) >= FREEHAND_MIN_PIXELS;
}

function handleMouseUp(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive || !isDragging) return;
  const map = boundMap;
  isDragging = false;
  if (!map || !dragStart) {
    resetDrawState();
    return;
  }

  if (activeTool === "freehand") {
    // Freehand is an open line (a pen stroke), not a closed/filled shape.
    freehandPath.push([event.lngLat.lng, event.lngLat.lat]);
    const path = freehandPath;
    dragStart = null;
    freehandPath = [];
    clearPreview(map);
    // Require a real stroke: a tap (or a drag smaller than the sampling
    // threshold) yields just the seeded start and the release point, which would
    // commit a zero-length line. A genuine drag samples at least one mid-point.
    if (path.length >= 3) appendAnnotationFeatures([lineFeature(path)]);
    return;
  }

  let ring: Position[] | null = null;
  if (activeTool === "rectangle") {
    ring = rectangleRing(dragStart, event.lngLat);
  } else if (activeTool === "ellipse") {
    ring = ellipseRing(dragStart, event.lngLat);
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
    // `text-color` is read per-feature by the layer-sync text-marker layer, so
    // each label keeps the color it was placed with (no retroactive recolor).
    properties: {
      __annotation: "text",
      shape: TEXT_MARKER_SHAPE,
      text,
      "text-color": strokeColor,
    },
  };
}

/**
 * Build the two features of an arrow: the shaft (a line) and a filled triangle
 * arrowhead at the end. The head is sized in screen pixels at the current zoom
 * and filled with the shaft color so the two read as one arrow. Returns an empty
 * array for a zero-length arrow. Used for both the live preview and the
 * committed arrow; the caller stamps a shared `annotationId` (see buildArrow).
 */
function arrowFeatures(
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

  const ux = dx / length;
  const uy = dy / length;
  // Perpendicular unit vector.
  const px = -uy;
  const py = ux;
  // Shrink the head for a short shaft so its base never sits behind the start
  // point (which would draw an inverted arrowhead the shaft punches through).
  const headLength = Math.min(ARROWHEAD_LENGTH_PX, length * 0.6);
  const headHalfWidth = ARROWHEAD_HALF_WIDTH_PX * (headLength / ARROWHEAD_LENGTH_PX);
  const baseX = endPx.x - ux * headLength;
  const baseY = endPx.y - uy * headLength;

  const tip = toPos(end);
  const left = toPos(map.unproject([baseX + px * headHalfWidth, baseY + py * headHalfWidth]));
  const right = toPos(map.unproject([baseX - px * headHalfWidth, baseY - py * headHalfWidth]));
  const head: Feature = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [ensureCcwRing([tip, left, right, tip])],
    },
    properties: {
      __annotation: "arrowhead",
      fill: strokeColor,
      "fill-opacity": 1,
      stroke: strokeColor,
      "stroke-width": 1,
    },
  };

  return [shaft, head];
}

/** An arrow's features with a shared `annotationId` so its parts delete together. */
function buildArrow(
  map: maplibregl.Map,
  start: maplibregl.LngLat,
  end: maplibregl.LngLat,
): Feature[] {
  const features = arrowFeatures(map, start, end);
  if (!features.length) return features;
  const annotationId = nextAnnotationId();
  for (const feature of features) {
    (feature.properties as Record<string, unknown>).annotationId = annotationId;
  }
  return features;
}

// A per-load random prefix so ids minted this session cannot collide with ids
// already saved in a reopened project (the counter restarts at 0 each load, so
// a bare `annotation-N` would clash and make "Delete last" drop a saved arrow).
const ANNOTATION_ID_PREFIX = Math.random().toString(36).slice(2, 8);
let annotationCounter = 0;
/**
 * A session-unique id grouping the parts of one annotation (e.g. an arrow's
 * shaft and head). Uniqueness is what lets "Delete last" remove every part of a
 * grouped annotation by id regardless of their order in the feature array; the
 * per-load prefix plus monotonic counter guarantees it within and across loads.
 */
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
  const existing = map.getSource(PREVIEW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    // The preview paint is data-driven (below), so the regenerated features —
    // which carry the current color/width — update the appearance on their own;
    // no per-property repaint is needed when color/width changes mid-draw.
    existing.setData(data);
    return;
  }
  map.addSource(PREVIEW_SOURCE_ID, { type: "geojson", data });
  // Read the same per-feature simplestyle the committed features carry, so the
  // preview matches the result — in particular the arrowhead previews as a solid
  // fill with a thin outline rather than the faint, thickly-outlined polygon a
  // flat preview style produced.
  map.addLayer({
    id: PREVIEW_FILL_LAYER_ID,
    type: "fill",
    source: PREVIEW_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": ["coalesce", ["get", "fill"], strokeColor],
      "fill-opacity": ["coalesce", ["get", "fill-opacity"], FILL_OPACITY],
    },
  });
  map.addLayer({
    id: PREVIEW_LINE_LAYER_ID,
    type: "line",
    source: PREVIEW_SOURCE_ID,
    // No dash: a dashed pattern was also drawn over the arrowhead polygon's
    // outline, so the previewed head looked unlike the (solid) committed one.
    // A solid, per-feature stroke makes the preview match the result exactly.
    paint: {
      "line-color": ["coalesce", ["get", "stroke"], strokeColor],
      "line-width": ["coalesce", ["get", "stroke-width"], strokeWidth],
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

function findAnnotationLayer(layers: GeoLibreLayer[]): GeoLibreLayer | undefined {
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

  if (existing) {
    annotationLayerId = existing.id;
    const next: FeatureCollection = {
      type: "FeatureCollection",
      features: [...(existing.geojson?.features ?? []), ...features],
    };
    store.updateLayer(existing.id, { geojson: next });
    return;
  }

  // Build the layer fully and add it in a single store mutation, so it never
  // appears with `sourceKind`/`simpleStyleEnabled` unset (which would briefly
  // render the first annotation without its per-feature colors). Text labels
  // carry their own `text-color`, shapes/arrows their own stroke/fill, so no
  // layer-level color needs setting here.
  const id = crypto.randomUUID();
  const layer: GeoLibreLayer = {
    id,
    name: labels.layerName,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      // Force the simplestyle path on so per-feature stroke/fill always apply,
      // even when the first annotation is text (which carries no simplestyle).
      simpleStyleEnabled: true,
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
  const groupId = (last.properties as Record<string, unknown> | null)?.annotationId;
  let remaining: Feature[];
  if (typeof groupId === "string") {
    remaining = features.filter(
      (feature) => (feature.properties as Record<string, unknown> | null)?.annotationId !== groupId,
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
