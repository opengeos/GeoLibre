import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection, Position } from "geojson";
import maplibregl from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
import { ANNOTATIONS_PLUGIN_ID } from "../plugin-ids";

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
  | "pin"
  | "sticky_note"
  | "placed_image"
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
let unregisterRightPanelDisposer: (() => void) | null = null;

// Transient draw state.
let boundMap: maplibregl.Map | null = null;
let arrowStart: maplibregl.LngLat | null = null;
let dragStart: maplibregl.LngLat | null = null;
let freehandPath: Position[] = [];
let isDragging = false;
let activeTextInput: HTMLInputElement | null = null;
// Idempotent finisher for the open text input (commits or discards once).
let finishTextInput: ((save: boolean) => void) | null = null;

export { ANNOTATIONS_PLUGIN_ID };

export const maplibreAnnotationsPlugin: GeoLibrePlugin = {
  id: ANNOTATIONS_PLUGIN_ID,
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

    if (typeof app.registerRightPanel === "function") {
      unregisterRightPanelDisposer = app.registerRightPanel({
        id: "geolibre-elements-panel",
        title: () => labels.elementsPanelTitle || "Elements",
        dock: "right-of-style",
        render: (container) => renderElementsPanel(container),
      });
    }
  },
  deactivate: (app: GeoLibreAppAPI) => {
    setActiveTool(null);
    cancelTextInput();
    unbindMap();
    if (toolbarControl) {
      app.removeMapControl(toolbarControl);
      toolbarControl = null;
    }
    unregisterRightPanelDisposer?.();
    unregisterRightPanelDisposer = null;
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
  pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  sticky_note:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><path d="M15 3v6h6"/></svg>',
  placed_image:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
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
  "pin",
  "sticky_note",
  "placed_image",
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
  /** Name of the layer the annotations are stored in (shown in the Layers panel). */
  layerName: string;
  elementsPanelTitle: string;
  tools: Partial<Record<AnnotationTool, string>>;
  color: string;
  width: string;
  widthOptions: { thin: string; medium: string; thick: string };
  deleteLast: string;
  clearAll: string;
  textPlaceholder: string;
  pinTitlePrompt: string;
  pinDescPrompt: string;
  stickyNotePrompt: string;
  imageUrlPrompt: string;
  cancel: string;
  saveElement: string;
  atPoint: string;
  pinnedToExtent: string;
}

let labels: AnnotationLabels = {
  toolbar: "Annotation tools",
  layerName: ANNOTATIONS_LAYER_NAME,
  elementsPanelTitle: "Elements",
  tools: {
    text: "Text",
    pin: "Pin marker",
    sticky_note: "Sticky note",
    placed_image: "Placed image",
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
  pinTitlePrompt: "Pin title:",
  pinDescPrompt: "Pin description (optional):",
  stickyNotePrompt: "Sticky note text:",
  imageUrlPrompt: "Image URL or Data URI:",
  cancel: "Cancel",
  saveElement: "Save Element",
  atPoint: "At Point",
  pinnedToExtent: "Pinned to Extent",
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
      this.applyLabel(button, () => labels.tools[tool] || tool);
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

  if (tool && typeof appApi?.openRightPanel === "function") {
    appApi.openRightPanel("geolibre-elements-panel");
  }
}

let activePopupContainer: HTMLElement | null = null;
let activePopupAnnotationId: string | null = null;
let activePopupLngLat: maplibregl.LngLat | null = null;

function closeElementPopup(): void {
  if (activePopupContainer) {
    activePopupContainer.remove();
    activePopupContainer = null;
  }
  activePopupAnnotationId = null;
  activePopupLngLat = null;
}

function computePopupPosition(
  map: maplibregl.Map,
  lngLat: maplibregl.LngLat,
): { left: number; top: number } {
  const point = map.project(lngLat);
  const canvasRect = map.getCanvasContainer().getBoundingClientRect();

  const boxWidth = 200;
  let left = point.x - boxWidth / 2;
  let top = point.y + 12;

  if (left < 10) left = 10;
  if (left + boxWidth > canvasRect.width - 10) left = canvasRect.width - boxWidth - 10;
  if (top + 180 > canvasRect.height - 10) top = Math.max(10, point.y - 190);

  return { left, top };
}

function repositionElementPopup(): void {
  if (!boundMap || !activePopupContainer || !activePopupLngLat) return;
  const { left, top } = computePopupPosition(boundMap, activePopupLngLat);

  activePopupContainer.style.left = `${left}px`;
  activePopupContainer.style.top = `${top}px`;
}

function showElementPopup(map: maplibregl.Map, lngLat: maplibregl.LngLat, feature: Feature): void {
  closeElementPopup();

  const props = (feature.properties as Record<string, unknown>) ?? {};
  const id = String(props.annotationId || feature.id);
  activePopupAnnotationId = id;
  activePopupLngLat = lngLat;
  const title = String(props.title || props.text || "Element");
  const description = props.description ? String(props.description) : "";
  const imageUrl = props.imageUrl ? String(props.imageUrl) : "";

  const { left, top } = computePopupPosition(map, lngLat);

  const container = document.createElement("div");
  container.className = "geolibre-element-popup-card";
  container.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    width: 200px;
    background: var(--geolibre-bg, #ffffff);
    color: var(--geolibre-fg, #111827);
    border: 1px solid var(--geolibre-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.15), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
    padding: 10px;
    z-index: 60;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    box-sizing: border-box;
  `;

  const stopProp = (e: Event) => e.stopPropagation();
  container.addEventListener("mousedown", stopProp);
  container.addEventListener("mouseup", stopProp);
  container.addEventListener("click", stopProp);
  container.addEventListener("pointerdown", stopProp);

  const header = document.createElement("div");
  header.style.cssText =
    "display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;";

  const titleEl = document.createElement("span");
  titleEl.style.cssText =
    "font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;";
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.style.cssText =
    "background: none; border: none; cursor: pointer; color: var(--geolibre-fg-muted, #6b7280); padding: 0;";
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    closeElementPopup();
  };
  header.appendChild(closeBtn);
  container.appendChild(header);

  if (imageUrl) {
    const wrapper = document.createElement("div");
    wrapper.style.cssText =
      "width: 100%; max-height: 140px; border-radius: 6px; overflow: hidden; margin-bottom: 6px; background: var(--geolibre-bg-subtle, #f3f4f6); display: flex; align-items: center; justify-content: center;";

    const img = document.createElement("img");
    img.src = imageUrl;
    img.style.cssText = "width: 100%; max-height: 140px; object-fit: contain; display: block;";

    img.onerror = () => {
      wrapper.innerHTML = `
        <div style="padding: 12px; text-align: center; color: var(--geolibre-fg-muted, #6b7280); font-size: 11px; display: flex; flex-direction: column; align-items: center; gap: 4px;">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <span>Image preview unavailable</span>
        </div>
      `;
    };

    wrapper.appendChild(img);
    container.appendChild(wrapper);
  }

  if (description) {
    const desc = document.createElement("div");
    desc.style.cssText =
      "color: var(--geolibre-fg-muted, #4b5563); font-size: 11px; line-height: 1.4; word-break: break-word;";
    desc.textContent = description;
    container.appendChild(desc);
  }

  map.getCanvasContainer().appendChild(container);
  activePopupContainer = container;
}

const activeImageMarkers = new Map<string, maplibregl.Marker>();
const activePinMarkers = new Map<string, maplibregl.Marker>();
const activeStickyMarkers = new Map<string, maplibregl.Marker>();
let elementMarkerUnsub: (() => void) | null = null;

/** Sync all element HTML markers (pins, sticky notes, placed images). */
function syncAllElementMarkers(): void {
  ensureAnnotationIdBackfill();
  syncPinMarkers();
  syncStickyNoteMarkers();
  syncPlacedImageMarkers();
}

// ---------------------------------------------------------------------------
// Pin markers — teardrop icon with title label, click opens description popup
// ---------------------------------------------------------------------------

function syncPinMarkers(): void {
  const map = boundMap;
  if (!map) return;
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  const features = (layer?.geojson?.features as Feature[]) ?? [];

  const currentIds = new Set<string>();

  for (const f of features) {
    const props = (f.properties as Record<string, unknown>) ?? {};
    if (props.__annotation !== "pin") continue;

    const id = String(props.annotationId || f.id);
    const visible = props.visible !== false;
    const geom = f.geometry as { type: string; coordinates: [number, number] };
    if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) continue;
    const coords = geom.coordinates;

    currentIds.add(id);

    if (!visible) {
      if (activePinMarkers.has(id)) {
        activePinMarkers.get(id)!.remove();
        activePinMarkers.delete(id);
      }
      if (activePopupAnnotationId === id) {
        closeElementPopup();
      }
      continue;
    }

    const rawColor = String(props.pinColor || props["text-color"] || "#ef4444");
    const pinColor = isValidColor(rawColor) ? rawColor : "#ef4444";

    if (!activePinMarkers.has(id)) {
      const container = document.createElement("div");
      container.className = "geolibre-pin-marker";
      container.style.cssText =
        "display: flex; flex-direction: column; align-items: center; cursor: pointer; user-select: none; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));";

      const pinSvg = document.createElement("div");
      pinSvg.className = "pin-svg-container";
      pinSvg.style.cssText = "display: flex; line-height: 0;";
      pinSvg.innerHTML = `<svg viewBox="0 0 24 36" width="28" height="42" fill="${pinColor}" stroke="#ffffff" stroke-width="1.5"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"/><circle cx="12" cy="11" r="4.5" fill="#ffffff" opacity="0.9"/></svg>`;
      container.appendChild(pinSvg);

      const titleEl = document.createElement("div");
      titleEl.className = "pin-title";
      titleEl.style.cssText =
        "background: var(--geolibre-bg, #fff); color: var(--geolibre-fg, #1f2937); font-family: system-ui, -apple-system, sans-serif; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; margin-top: -6px; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 1px 4px rgba(0,0,0,0.15); border: 1px solid var(--geolibre-border, #d1d5db);";
      titleEl.textContent = String(props.title || "Pin");
      container.appendChild(titleEl);

      container.onclick = (e) => {
        e.stopPropagation();
        showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
      };

      const marker = new maplibregl.Marker({ element: container, anchor: "bottom" })
        .setLngLat(coords as [number, number])
        .addTo(map);

      activePinMarkers.set(id, marker);
    } else {
      const marker = activePinMarkers.get(id)!;
      marker.setLngLat(coords as [number, number]);
      const container = marker.getElement();
      const pinSvg = container.querySelector(".pin-svg-container");
      if (pinSvg) {
        pinSvg.innerHTML = `<svg viewBox="0 0 24 36" width="28" height="42" fill="${pinColor}" stroke="#ffffff" stroke-width="1.5"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"/><circle cx="12" cy="11" r="4.5" fill="#ffffff" opacity="0.9"/></svg>`;
      }
      const titleEl = container.querySelector(".pin-title");
      if (titleEl) {
        titleEl.textContent = String(props.title || "Pin");
      }
      container.onclick = (e) => {
        e.stopPropagation();
        showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
      };
    }

    if (activePopupAnnotationId === id) {
      showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
    }
  }

  for (const [id, marker] of activePinMarkers.entries()) {
    if (!currentIds.has(id)) {
      marker.remove();
      activePinMarkers.delete(id);
      if (activePopupAnnotationId === id) {
        closeElementPopup();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sticky note markers — colored card with title + body, screen-space sized
// ---------------------------------------------------------------------------

function syncStickyNoteMarkers(): void {
  const map = boundMap;
  if (!map) return;
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  const features = (layer?.geojson?.features as Feature[]) ?? [];

  const currentIds = new Set<string>();

  for (const f of features) {
    const props = (f.properties as Record<string, unknown>) ?? {};
    if (props.__annotation !== "sticky_note") continue;

    const id = String(props.annotationId || f.id);
    const visible = props.visible !== false;
    const geom = f.geometry as { type: string; coordinates: [number, number] };
    if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) continue;
    const coords = geom.coordinates;

    currentIds.add(id);

    if (!visible) {
      if (activeStickyMarkers.has(id)) {
        activeStickyMarkers.get(id)!.remove();
        activeStickyMarkers.delete(id);
      }
      if (activePopupAnnotationId === id) {
        closeElementPopup();
      }
      continue;
    }

    const rawBgColor = String(props.fill || "#fbbf24");
    const bgColor = isValidColor(rawBgColor) ? rawBgColor : "#fbbf24";
    // Derive readable text color: dark text on light backgrounds, white on dark.
    const textColor = isLightColor(bgColor) ? "#1f2937" : "#ffffff";

    if (!activeStickyMarkers.has(id)) {
      const container = document.createElement("div");
      container.className = "geolibre-sticky-note-marker";
      container.style.cssText = `
        min-width: 100px; max-width: 180px; padding: 8px 10px;
        background: ${bgColor}; color: ${textColor};
        border-radius: 6px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.12);
        cursor: pointer; user-select: none;
        font-family: system-ui, -apple-system, sans-serif;
        border: 1px solid rgba(0,0,0,0.08);
      `;

      const titleEl = document.createElement("div");
      titleEl.className = "sticky-title";
      titleEl.style.cssText =
        "font-size: 12px; font-weight: 700; margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
      titleEl.textContent = String(props.title || "Note");
      container.appendChild(titleEl);

      const bodyText = String(props.description || "");
      const bodyEl = document.createElement("div");
      bodyEl.className = "sticky-body";
      bodyEl.style.cssText =
        "font-size: 11px; line-height: 1.35; word-break: break-word; opacity: 0.85; max-height: 60px; overflow: hidden;";
      bodyEl.textContent = bodyText;
      bodyEl.style.display = bodyText ? "block" : "none";
      container.appendChild(bodyEl);

      // Small anchor triangle at the bottom pointing down.
      const anchor = document.createElement("div");
      anchor.className = "sticky-anchor";
      anchor.style.cssText = `
        position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%);
        width: 0; height: 0;
        border-left: 6px solid transparent; border-right: 6px solid transparent;
        border-top: 6px solid ${bgColor};
      `;
      container.style.position = "relative";
      container.appendChild(anchor);

      container.onclick = (e) => {
        e.stopPropagation();
        showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
      };

      const marker = new maplibregl.Marker({ element: container, anchor: "bottom" })
        .setLngLat(coords as [number, number])
        .addTo(map);

      activeStickyMarkers.set(id, marker);
    } else {
      const marker = activeStickyMarkers.get(id)!;
      marker.setLngLat(coords as [number, number]);
      const container = marker.getElement();
      container.style.background = bgColor;
      container.style.color = textColor;

      const titleEl = container.querySelector(".sticky-title");
      if (titleEl) {
        titleEl.textContent = String(props.title || "Note");
      }

      const bodyText = String(props.description || "");
      const bodyEl = container.querySelector<HTMLElement>(".sticky-body");
      if (bodyEl) {
        bodyEl.textContent = bodyText;
        bodyEl.style.display = bodyText ? "block" : "none";
      }

      const anchor = container.querySelector<HTMLElement>(".sticky-anchor");
      if (anchor) {
        anchor.style.borderTopColor = bgColor;
      }

      container.onclick = (e) => {
        e.stopPropagation();
        showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
      };
    }

    if (activePopupAnnotationId === id) {
      showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
    }
  }

  for (const [id, marker] of activeStickyMarkers.entries()) {
    if (!currentIds.has(id)) {
      marker.remove();
      activeStickyMarkers.delete(id);
      if (activePopupAnnotationId === id) {
        closeElementPopup();
      }
    }
  }
}

/** Rough light/dark heuristic for choosing readable text on a background. */
function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "");
  if (c.length < 6) return true;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  // Perceived luminance (sRGB).
  return r * 0.299 + g * 0.587 + b * 0.114 > 150;
}

function isValidColor(color: string): boolean {
  if (!color) return false;
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) return true;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*(?:\d+(?:\.\d+)?|\.\d+)\s*)?\)$/.test(color))
    return true;
  if (/^hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*(?:,\s*(?:\d+(?:\.\d+)?|\.\d+)\s*)?\)$/.test(color))
    return true;
  return /^[a-zA-Z]{3,20}$/.test(color);
}

// ---------------------------------------------------------------------------
// Placed image markers — pill badge with image icon, click opens preview popup
// ---------------------------------------------------------------------------

function syncPlacedImageMarkers(): void {
  const map = boundMap;
  if (!map) return;
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  const features = (layer?.geojson?.features as Feature[]) ?? [];

  const currentIds = new Set<string>();

  for (const f of features) {
    const props = (f.properties as Record<string, unknown>) ?? {};
    if (props.__annotation !== "placed_image" || !props.imageUrl) continue;

    const id = String(props.annotationId || f.id);
    const visible = props.visible !== false;
    const geom = f.geometry as { type: string; coordinates: [number, number] };
    if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) continue;
    const coords = geom.coordinates;

    currentIds.add(id);

    if (!visible) {
      if (activeImageMarkers.has(id)) {
        activeImageMarkers.get(id)!.remove();
        activeImageMarkers.delete(id);
      }
      if (activePopupAnnotationId === id) {
        closeElementPopup();
      }
      continue;
    }

    if (!activeImageMarkers.has(id)) {
      const container = document.createElement("div");
      container.className = "geolibre-placed-image-marker";
      container.style.cssText =
        "display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--geolibre-bg, #ffffff); color: var(--geolibre-fg, #1f2937); border-radius: 16px; border: 1px solid var(--geolibre-border, #d1d5db); box-shadow: 0 2px 8px rgba(0,0,0,0.18); cursor: pointer; font-family: system-ui, -apple-system, sans-serif; font-size: 11px; font-weight: 500; user-select: none;";

      const iconSpan = document.createElement("span");
      iconSpan.style.cssText = "display: inline-flex; align-items: center; color: #3b82f6;";
      iconSpan.innerHTML = TOOL_ICONS.placed_image;
      container.appendChild(iconSpan);

      const titleSpan = document.createElement("span");
      titleSpan.className = "image-title";
      titleSpan.textContent = String(props.title || "Placed Image");
      container.appendChild(titleSpan);

      container.onclick = (e) => {
        e.stopPropagation();
        showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
      };

      const marker = new maplibregl.Marker({ element: container })
        .setLngLat(coords as [number, number])
        .addTo(map);

      activeImageMarkers.set(id, marker);
    } else {
      const marker = activeImageMarkers.get(id)!;
      marker.setLngLat(coords as [number, number]);
      const container = marker.getElement();
      const titleSpan = container.querySelector(".image-title");
      if (titleSpan) {
        titleSpan.textContent = String(props.title || "Placed Image");
      }
      container.onclick = (e) => {
        e.stopPropagation();
        showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
      };
    }

    if (activePopupAnnotationId === id) {
      showElementPopup(map, new maplibregl.LngLat(coords[0], coords[1]), f);
    }
  }

  for (const [id, marker] of activeImageMarkers.entries()) {
    if (!currentIds.has(id)) {
      marker.remove();
      activeImageMarkers.delete(id);
      if (activePopupAnnotationId === id) {
        closeElementPopup();
      }
    }
  }
}

function clearAllElementMarkers(): void {
  for (const marker of activeImageMarkers.values()) marker.remove();
  activeImageMarkers.clear();
  for (const marker of activePinMarkers.values()) marker.remove();
  activePinMarkers.clear();
  for (const marker of activeStickyMarkers.values()) marker.remove();
  activeStickyMarkers.clear();
}

function bindMap(map: maplibregl.Map): void {
  if (boundMap === map) return;
  unbindMap();
  boundMap = map;
  map.on("click", handleClick);
  map.on("mousedown", handleMouseDown);
  map.on("mousemove", handleMouseMove);
  map.on("mouseup", handleMouseUp);
  map.on("move", repositionElementPopup);
  window.addEventListener("mouseup", handleWindowMouseUp);
  map.getCanvas().addEventListener("keydown", handleKeyDown, { capture: true });
  elementMarkerUnsub = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) {
      syncAllElementMarkers();
    }
  });
  syncAllElementMarkers();
}

function handleWindowMouseUp(): void {
  if (!isDragging) return;
  isDragging = false;
  dragStart = null;
  freehandPath = [];
  if (boundMap) clearPreview(boundMap);
}

function unbindMap(): void {
  const map = boundMap;
  elementMarkerUnsub?.();
  elementMarkerUnsub = null;
  clearAllElementMarkers();
  closeElementPopup();
  closeElementDialog();
  if (!map) return;
  map.off("click", handleClick);
  map.off("mousedown", handleMouseDown);
  map.off("mousemove", handleMouseMove);
  map.off("mouseup", handleMouseUp);
  map.off("move", repositionElementPopup);
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

let activeElementDialog: HTMLElement | null = null;

function closeElementDialog(): void {
  if (activeElementDialog) {
    activeElementDialog.remove();
    activeElementDialog = null;
  }
  setActiveTool(null);
}

interface ElementDialogData {
  title: string;
  description: string;
  imageUrl?: string;
  color?: string;
  placementMode?: "point" | "extent";
}

function openElementDialog(
  event: maplibregl.MapMouseEvent,
  type: "pin" | "sticky_note" | "placed_image",
  onSubmit: (data: ElementDialogData) => void,
): void {
  const map = boundMap;
  if (!map) return;
  closeElementDialog();

  const container = document.createElement("div");
  container.className = "geolibre-annotation-dialog";

  const stopProp = (e: Event) => e.stopPropagation();
  container.addEventListener("mousedown", stopProp);
  container.addEventListener("mouseup", stopProp);
  container.addEventListener("click", stopProp);
  container.addEventListener("dblclick", stopProp);
  container.addEventListener("pointerdown", stopProp);
  container.addEventListener("pointerup", stopProp);

  const canvasRect = map.getCanvasContainer().getBoundingClientRect();
  const boxWidth = 260;
  const boxHeight = type === "placed_image" ? 220 : 250;
  let left = event.point.x + 10;
  let top = event.point.y + 10;
  if (left + boxWidth > canvasRect.width) left = Math.max(10, event.point.x - boxWidth - 10);
  if (top + boxHeight > canvasRect.height) top = Math.max(10, event.point.y - boxHeight - 10);

  container.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    width: ${boxWidth}px;
    background: var(--geolibre-bg, #ffffff);
    color: var(--geolibre-fg, #111827);
    border: 1px solid var(--geolibre-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.15), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
    padding: 12px;
    z-index: 50;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
  `;

  const typeTitles = {
    pin: labels.tools.pin || "Add Pin",
    sticky_note: labels.tools.sticky_note || "Add Sticky Note",
    placed_image: labels.tools.placed_image || "Add Placed Image",
  };

  const header = document.createElement("div");
  header.style.cssText =
    "display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-weight: 600;";
  header.textContent = typeTitles[type];

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.style.cssText =
    "background: none; border: none; cursor: pointer; color: var(--geolibre-fg-muted, #6b7280); padding: 2px;";
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    closeElementDialog();
  };
  header.appendChild(closeBtn);
  container.appendChild(header);

  const titleLabel = document.createElement("label");
  titleLabel.style.cssText =
    "display: block; font-size: 11px; font-weight: 500; margin-bottom: 3px; color: var(--geolibre-fg-muted, #6b7280);";
  titleLabel.textContent = type === "pin" ? labels.pinTitlePrompt : "Title";
  container.appendChild(titleLabel);

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.value =
    type === "pin" ? "Pin 1" : type === "sticky_note" ? "Sticky Note" : "Placed Image";
  titleInput.style.cssText =
    "width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--geolibre-border, #d1d5db); background: var(--geolibre-bg-subtle, #f9fafb); color: inherit; font-size: 12px; margin-bottom: 8px;";
  container.appendChild(titleInput);

  let descInput: HTMLTextAreaElement | HTMLInputElement | null = null;
  let placementMode: "point" | "extent" = "point";
  if (type === "placed_image") {
    // Placement mode toggle: point (marker) vs extent (corner-pinned overlay).
    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display: flex; gap: 4px; margin-bottom: 8px;";
    const makeToggle = (btnLabel: string, mode: "point" | "extent") => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = btnLabel;
      btn.dataset.mode = mode;
      btn.style.cssText = `flex: 1; padding: 5px 0; border-radius: 6px; border: 1px solid var(--geolibre-border, #d1d5db); font-size: 11px; cursor: pointer; transition: background 0.15s; ${
        mode === "point"
          ? "background: var(--geolibre-primary, #3b82f6); color: #fff; border-color: var(--geolibre-primary, #3b82f6);"
          : "background: transparent; color: inherit;"
      }`;
      btn.onclick = (e) => {
        e.stopPropagation();
        placementMode = mode;
        for (const child of modeRow.children) {
          const el = child as HTMLButtonElement;
          if (el.dataset.mode === mode) {
            el.style.background = "var(--geolibre-primary, #3b82f6)";
            el.style.color = "#fff";
            el.style.borderColor = "var(--geolibre-primary, #3b82f6)";
          } else {
            el.style.background = "transparent";
            el.style.color = "inherit";
            el.style.borderColor = "var(--geolibre-border, #d1d5db)";
          }
        }
      };
      return btn;
    };
    modeRow.appendChild(makeToggle(labels.atPoint, "point"));
    modeRow.appendChild(makeToggle(labels.pinnedToExtent, "extent"));
    container.appendChild(modeRow);

    const urlLabel = document.createElement("label");
    urlLabel.style.cssText =
      "display: block; font-size: 11px; font-weight: 500; margin-bottom: 3px; color: var(--geolibre-fg-muted, #6b7280);";
    urlLabel.textContent = labels.imageUrlPrompt;
    container.appendChild(urlLabel);

    descInput = document.createElement("input");
    descInput.type = "url";
    descInput.placeholder = "https://example.com/image.png";
    descInput.style.cssText =
      "width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--geolibre-border, #d1d5db); background: var(--geolibre-bg-subtle, #f9fafb); color: inherit; font-size: 12px; margin-bottom: 8px;";
    descInput.oninput = () => {
      descInput!.style.borderColor = "";
    };
    container.appendChild(descInput);
  } else {
    const contentLabel = document.createElement("label");
    contentLabel.style.cssText =
      "display: block; font-size: 11px; font-weight: 500; margin-bottom: 3px; color: var(--geolibre-fg-muted, #6b7280);";
    contentLabel.textContent = type === "pin" ? labels.pinDescPrompt : labels.stickyNotePrompt;
    container.appendChild(contentLabel);

    descInput = document.createElement("textarea");
    descInput.rows = 3;
    descInput.placeholder = type === "pin" ? "Optional description..." : "Type note details...";
    descInput.style.cssText =
      "width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--geolibre-border, #d1d5db); background: var(--geolibre-bg-subtle, #f9fafb); color: inherit; font-size: 12px; resize: vertical; margin-bottom: 8px;";
    container.appendChild(descInput);
  }

  let selectedColor = strokeColor;
  const colorRow = document.createElement("div");
  colorRow.style.cssText =
    "display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;";
  const colorLabel = document.createElement("span");
  colorLabel.style.cssText =
    "font-size: 11px; font-weight: 500; color: var(--geolibre-fg-muted, #6b7280);";
  colorLabel.textContent = "Color";
  colorRow.appendChild(colorLabel);

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = selectedColor;
  colorInput.style.cssText =
    "width: 28px; height: 24px; border: none; background: none; cursor: pointer;";
  colorInput.oninput = () => {
    selectedColor = colorInput.value;
  };
  colorRow.appendChild(colorInput);
  container.appendChild(colorRow);

  const footer = document.createElement("div");
  footer.style.cssText = "display: flex; align-items: center; justify-content: flex-end; gap: 6px;";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = labels.cancel;
  cancelBtn.style.cssText =
    "padding: 5px 10px; border-radius: 6px; border: 1px solid var(--geolibre-border, #d1d5db); background: transparent; color: inherit; font-size: 12px; cursor: pointer;";
  cancelBtn.onclick = (e) => {
    e.stopPropagation();
    closeElementDialog();
  };
  footer.appendChild(cancelBtn);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = labels.saveElement;
  saveBtn.style.cssText =
    "padding: 5px 10px; border-radius: 6px; border: none; background: var(--geolibre-primary, #3b82f6); color: #ffffff; font-size: 12px; font-weight: 500; cursor: pointer;";
  saveBtn.onclick = (e) => {
    e.stopPropagation();
    const title =
      titleInput.value.trim() ||
      (type === "pin" ? "Pin 1" : type === "sticky_note" ? "Sticky Note" : "Placed Image");
    const description = descInput ? descInput.value.trim() : "";

    if (type === "placed_image" && !description) {
      if (descInput) {
        descInput.style.borderColor = "var(--geolibre-error, #ef4444)";
        descInput.focus();
      }
      return;
    }

    onSubmit({
      title,
      description,
      imageUrl: type === "placed_image" ? description : undefined,
      color: selectedColor,
      placementMode,
    });
    closeElementDialog();
  };
  footer.appendChild(saveBtn);
  container.appendChild(footer);

  container.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      closeElementDialog();
    }
  };

  map.getCanvasContainer().appendChild(container);
  activeElementDialog = container;
  titleInput.focus();
  titleInput.select();
}

function handleClick(event: maplibregl.MapMouseEvent): void {
  if (!pluginActive) return;
  if (activeTool === "text") {
    openTextInput(event);
    return;
  }
  if (activeTool === "pin") {
    openElementDialog(event, "pin", (data) => {
      appendAnnotationFeatures([
        pinFeature(event.lngLat, data.title, data.description, data.color),
      ]);
    });
    return;
  }
  if (activeTool === "sticky_note") {
    openElementDialog(event, "sticky_note", (data) => {
      appendAnnotationFeatures([
        stickyNoteFeature(event.lngLat, data.description || "Note", data.title, data.color),
      ]);
    });
    return;
  }
  if (activeTool === "placed_image") {
    openElementDialog(event, "placed_image", (data) => {
      const imageUrl = data.imageUrl || "";
      if (data.placementMode === "extent") {
        // Corner-pinned placement: use the store's addImageOverlayLayer API.
        // Compute a rectangular extent around the click point, then let the
        // image overlay layer handle rendering. Also create a tracking feature
        // in the annotation layer so the Elements panel can list/manage it.
        const lng = event.lngLat.lng;
        const lat = event.lngLat.lat;
        // Default extent: ~0.01 deg each side (~1 km at equator).
        const d = 0.01;
        const corners: [number, number][] = [
          [lng - d, lat + d], // top-left
          [lng + d, lat + d], // top-right
          [lng + d, lat - d], // bottom-right
          [lng - d, lat - d], // bottom-left
        ];
        const overlayLayerId = useAppStore
          .getState()
          .addImageOverlayLayer(
            data.title,
            { url: imageUrl, coordinates: corners },
            { bounds: [lng - d, lat - d, lng + d, lat + d] },
          );
        // Tracking feature so the Elements panel can manage this overlay.
        const trackingFeature: Feature = {
          type: "Feature",
          geometry: { type: "Point", coordinates: toPos(event.lngLat) },
          properties: {
            annotationId: nextAnnotationId(),
            __annotation: "placed_image",
            title: data.title,
            imageUrl,
            placementMode: "extent",
            overlayLayerId,
            shape: TEXT_MARKER_SHAPE,
            text: "",
            visible: true,
          },
        };
        appendAnnotationFeatures([trackingFeature]);
      } else {
        appendAnnotationFeatures([placedImageFeature(event.lngLat, imageUrl, data.title)]);
      }
    });
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

export function pinFeature(
  lngLat: maplibregl.LngLat,
  title: string,
  description: string = "",
  color: string = strokeColor,
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: toPos(lngLat) },
    properties: {
      annotationId: nextAnnotationId(),
      __annotation: "pin",
      title,
      description,
      pinColor: color,
      // Keep TEXT_MARKER_SHAPE to exclude from the circle layer; set text to
      // empty so the text symbol layer renders nothing — the custom HTML marker
      // (syncPinMarkers) handles all visual rendering.
      shape: TEXT_MARKER_SHAPE,
      text: "",
      visible: true,
    },
  };
}

export function stickyNoteFeature(
  lngLat: maplibregl.LngLat,
  text: string,
  title: string = "Sticky Note",
  color: string = strokeColor,
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: toPos(lngLat) },
    properties: {
      annotationId: nextAnnotationId(),
      __annotation: "sticky_note",
      title,
      description: text,
      // Keep TEXT_MARKER_SHAPE to exclude from the circle layer; set text to
      // empty so the text symbol layer renders nothing — the custom HTML marker
      // (syncStickyNoteMarkers) handles all visual rendering as a card.
      shape: TEXT_MARKER_SHAPE,
      text: "",
      fill: color,
      visible: true,
    },
  };
}

export function placedImageFeature(
  lngLat: maplibregl.LngLat,
  imageUrl: string,
  title: string = "Placed Image",
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: toPos(lngLat) },
    properties: {
      annotationId: nextAnnotationId(),
      __annotation: "placed_image",
      title,
      imageUrl,
      // Keep TEXT_MARKER_SHAPE to exclude from the circle layer; set text to
      // empty — the HTML marker (syncPlacedImageMarkers) handles display.
      shape: TEXT_MARKER_SHAPE,
      text: "",
      visible: true,
    },
  };
}

function lineFeature(coordinates: Position[]): Feature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: {
      annotationId: nextAnnotationId(),
      __annotation: "freehand",
      title: "Freehand stroke",
      visible: true,
      ...strokeProps(),
    },
  };
}

function polygonFeature(ring: Position[]): Feature {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ensureCcwRing(ring)] },
    properties: {
      annotationId: nextAnnotationId(),
      __annotation: "highlight",
      title: "Highlight shape",
      visible: true,
      ...fillProps(),
    },
  };
}

function textFeature(lngLat: maplibregl.LngLat, text: string): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: toPos(lngLat) },
    properties: {
      annotationId: nextAnnotationId(),
      __annotation: "text",
      title: text,
      shape: TEXT_MARKER_SHAPE,
      text,
      "text-color": strokeColor,
      visible: true,
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
  if (layer) {
    ensureAnnotationIdBackfill(layer);
  }
}

function ensureAnnotationIdBackfill(annotationLayer?: GeoLibreLayer): void {
  const store = useAppStore.getState();
  const layer = annotationLayer ?? findAnnotationLayer(store.layers);
  if (!layer || !layer.geojson || !Array.isArray(layer.geojson.features)) return;

  const rawFeatures = layer.geojson.features as Feature[];
  let changed = false;

  const updatedFeatures = rawFeatures.map((f) => {
    const props = (f.properties as Record<string, unknown>) ?? {};
    if (!props.annotationId) {
      changed = true;
      return {
        ...f,
        properties: {
          ...props,
          annotationId: crypto.randomUUID(),
        },
      };
    }
    return f;
  });

  if (changed) {
    store.updateLayer(layer.id, {
      geojson: {
        ...layer.geojson,
        type: "FeatureCollection",
        features: updatedFeatures,
      },
    });
  }
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

// ---------------------------------------------------------------------------
// Elements Panel UI & Control
// ---------------------------------------------------------------------------

export function renderElementsPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.className = "geolibre-elements-panel";
  container.style.cssText =
    "padding: 12px; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: var(--geolibre-fg, #1f2937); height: 100%; box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;";

  let editingId: string | null = null;

  const update = () => {
    const store = useAppStore.getState();
    const layer = findAnnotationLayer(store.layers);
    const rawFeatures = (layer?.geojson?.features as Feature[]) ?? [];

    const map = new Map<
      string,
      {
        id: string;
        type: string;
        title: string;
        description?: string;
        visible: boolean;
        features: Feature[];
      }
    >();

    for (const f of rawFeatures) {
      const props = (f.properties as Record<string, unknown>) ?? {};
      const id = String(props.annotationId);
      if (!map.has(id)) {
        const type = String(props.__annotation || props.shape || "element");
        const title = String(props.title || props.text || "Element");
        const description = props.description ? String(props.description) : undefined;
        const visible = props.visible !== false;
        map.set(id, { id, type, title, description, visible, features: [f] });
      } else {
        map.get(id)!.features.push(f);
      }
    }

    const elements = Array.from(map.values());
    container.innerHTML = "";

    const header = document.createElement("div");
    header.style.cssText =
      "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--geolibre-border, #e5e7eb); padding-bottom: 6px; font-weight: 600;";
    header.textContent = `${labels.elementsPanelTitle} (${elements.length})`;
    container.appendChild(header);

    if (elements.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color: #9ca3af; text-align: center; padding: 24px 0;";
      empty.textContent = "No map elements yet.";
      container.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

    elements.forEach((el, index) => {
      const row = document.createElement("div");
      row.style.cssText = `display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; background: var(--geolibre-bg-subtle, #f9fafb); border: 1px solid var(--geolibre-border, #e5e7eb); ${
        !el.visible ? "opacity: 0.5;" : ""
      }`;

      const icon = document.createElement("span");
      icon.style.cssText =
        "display: inline-flex; align-items: center; color: var(--geolibre-fg-muted, #6b7280);";
      icon.innerHTML = getGlyphIcon(el.type);
      row.appendChild(icon);

      const titleContainer = document.createElement("div");
      titleContainer.style.cssText =
        "flex: 1; min-width: 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

      if (editingId === el.id) {
        const input = document.createElement("input");
        input.type = "text";
        input.value = el.title;
        input.style.cssText =
          "width: 100%; box-sizing: border-box; font-size: 12px; padding: 2px 4px; border: 1px solid #3b82f6; border-radius: 3px;";
        const commit = () => {
          const val = input.value.trim();
          if (val && val !== el.title) {
            const patch: Record<string, unknown> = { title: val };
            if (el.type === "text") {
              patch.text = val;
            }
            updateElementProps(el.id, patch);
          }
          editingId = null;
          update();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            editingId = null;
            update();
          }
        });
        titleContainer.appendChild(input);
        setTimeout(() => input.focus(), 10);
      } else {
        const t = document.createElement("span");
        t.style.fontWeight = "500";
        t.textContent = el.title;
        titleContainer.appendChild(t);
        titleContainer.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          editingId = el.id;
          update();
        });
        titleContainer.addEventListener("click", () => {
          zoomToElementFeatures(el.features);
        });
      }
      row.appendChild(titleContainer);

      const ctrl = document.createElement("div");
      ctrl.style.cssText = "display: flex; align-items: center; gap: 2px;";

      const up = document.createElement("button");
      up.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>`;
      up.title = "Move Up";
      up.style.cssText =
        "border: none; background: none; cursor: pointer; display: inline-flex; align-items: center; color: #6b7280; padding: 2px;";
      up.disabled = index === 0;
      up.addEventListener("click", (e) => {
        e.stopPropagation();
        reorderElements(el.id, "up");
      });
      ctrl.appendChild(up);

      const down = document.createElement("button");
      down.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
      down.title = "Move Down";
      down.style.cssText =
        "border: none; background: none; cursor: pointer; display: inline-flex; align-items: center; color: #6b7280; padding: 2px;";
      down.disabled = index === elements.length - 1;
      down.addEventListener("click", (e) => {
        e.stopPropagation();
        reorderElements(el.id, "down");
      });
      ctrl.appendChild(down);

      const vis = document.createElement("button");
      vis.innerHTML = el.visible
        ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
        : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
      vis.title = el.visible ? "Hide" : "Show";
      vis.style.cssText =
        "border: none; background: none; cursor: pointer; display: inline-flex; align-items: center; color: #4b5563; padding: 2px;";
      vis.addEventListener("click", (e) => {
        e.stopPropagation();
        updateElementProps(el.id, { visible: !el.visible });
      });
      ctrl.appendChild(vis);

      const del = document.createElement("button");
      del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      del.title = "Delete";
      del.style.cssText =
        "border: none; background: none; cursor: pointer; display: inline-flex; align-items: center; color: #ef4444; padding: 2px;";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteElementById(el.id);
      });
      ctrl.appendChild(del);

      row.appendChild(ctrl);
      list.appendChild(row);
    });

    container.appendChild(list);
  };

  update();
  const unsub = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) {
      update();
    }
  });
  return () => unsub();
}

function getGlyphIcon(type: string): string {
  switch (type) {
    case "pin":
      return TOOL_ICONS.pin;
    case "sticky_note":
      return TOOL_ICONS.sticky_note;
    case "placed_image":
      return TOOL_ICONS.placed_image;
    case "text":
      return TOOL_ICONS.text;
    case "arrow":
    case "arrowhead":
      return TOOL_ICONS.arrow;
    case "highlight":
      return TOOL_ICONS.rectangle;
    case "freehand":
    case "line":
      return TOOL_ICONS.freehand;
    default:
      return TOOL_ICONS.pin;
  }
}

function zoomToElementFeatures(features: Feature[]): void {
  const map = boundMap;
  if (!map || !features.length) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const processCoord = (c: Position) => {
    minX = Math.min(minX, c[0]);
    minY = Math.min(minY, c[1]);
    maxX = Math.max(maxX, c[0]);
    maxY = Math.max(maxY, c[1]);
  };
  for (const f of features) {
    if (f.geometry.type === "Point") {
      processCoord(f.geometry.coordinates);
    } else if (f.geometry.type === "LineString") {
      f.geometry.coordinates.forEach(processCoord);
    } else if (f.geometry.type === "Polygon") {
      f.geometry.coordinates.flatMap((r) => r).forEach(processCoord);
    }
  }
  if (!Number.isFinite(minX)) return;
  if (minX === maxX && minY === maxY) {
    map.flyTo({ center: [minX, minY], zoom: 15 });
  } else {
    map.fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding: 40 },
    );
  }
}

export function updateElementProps(annotationId: string, newProps: Record<string, unknown>): void {
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  if (!layer || !layer.geojson) return;
  const updatedFeatures = layer.geojson.features.map((f) => {
    const props = f.properties as Record<string, unknown>;
    if (props && props.annotationId === annotationId) {
      return { ...f, properties: { ...props, ...newProps } };
    }
    return f;
  });
  store.updateLayer(layer.id, {
    geojson: { ...layer.geojson, features: updatedFeatures },
  });

  // Cascade visibility toggle to the linked overlay layer (extent-placed images).
  if ("visible" in newProps) {
    const feature = layer.geojson.features.find(
      (f) => (f.properties as Record<string, unknown>)?.annotationId === annotationId,
    );
    const overlayId = (feature?.properties as Record<string, unknown>)?.overlayLayerId;
    if (typeof overlayId === "string") {
      store.setLayerVisibility(overlayId, newProps.visible !== false);
    }
  }
}

export function reorderElements(annotationId: string, direction: "up" | "down"): void {
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  if (!layer || !layer.geojson) return;

  const features = layer.geojson.features;
  const ids: string[] = [];
  for (const f of features) {
    const id = String((f.properties as Record<string, unknown>)?.annotationId || "");
    if (id && !ids.includes(id)) ids.push(id);
  }

  const idx = ids.indexOf(annotationId);
  if (idx === -1) return;
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= ids.length) return;

  const temp = ids[idx];
  ids[idx] = ids[targetIdx];
  ids[targetIdx] = temp;

  const grouped = new Map<string, Feature[]>();
  for (const f of features) {
    const id = String((f.properties as Record<string, unknown>)?.annotationId || "");
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id)!.push(f);
  }

  const reorderedFeatures: Feature[] = [];
  for (const id of ids) {
    const list = grouped.get(id);
    if (list) reorderedFeatures.push(...list);
  }

  store.updateLayer(layer.id, {
    geojson: { ...layer.geojson, features: reorderedFeatures },
  });
}

export function deleteElementById(annotationId: string): void {
  const store = useAppStore.getState();
  const layer = findAnnotationLayer(store.layers);
  if (!layer || !layer.geojson) return;

  // Cascade deletion to a linked overlay layer (extent-placed images).
  const target = layer.geojson.features.find(
    (f) => (f.properties as Record<string, unknown>)?.annotationId === annotationId,
  );
  const overlayId = (target?.properties as Record<string, unknown>)?.overlayLayerId;
  if (typeof overlayId === "string") {
    store.removeLayer(overlayId);
  }

  const remaining = layer.geojson.features.filter(
    (f) => (f.properties as Record<string, unknown>)?.annotationId !== annotationId,
  );
  if (remaining.length === 0) {
    store.removeLayer(layer.id);
    annotationLayerId = null;
  } else {
    store.updateLayer(layer.id, {
      geojson: { ...layer.geojson, features: remaining },
    });
  }
}
