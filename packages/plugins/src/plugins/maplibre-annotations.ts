import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
  GeoLibrePluginActivationContext,
} from "../types";

/** Engine-neutral marker on the GeoJSON layer that stores annotation features. */
export const ANNOTATIONS_SOURCE_KIND = "annotation";

/** Stable id for the lazy adapter-owned annotation control runtime. */
export const ANNOTATIONS_PLUGIN_ID = "maplibre-gl-annotations";

type AnnotationTool = "text" | "arrow" | "rectangle" | "ellipse" | "freehand";

/** Translated copy supplied by the host for the adapter-owned annotation toolbar. */
export interface AnnotationLabels {
  toolbar: string;
  layerName: string;
  tools: Record<AnnotationTool, string>;
  color: string;
  width: string;
  widthOptions: { thin: string; medium: string; thick: string };
  deleteLast: string;
  clearAll: string;
  textPlaceholder: string;
}

const DEFAULT_ANNOTATION_LABELS: AnnotationLabels = {
  toolbar: "Annotation tools",
  layerName: "Annotations",
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

let labels: AnnotationLabels = { ...DEFAULT_ANNOTATION_LABELS };
let position: GeoLibreMapControlPosition = "top-left";
let activeApp: GeoLibreAppAPI | null = null;

function runtimeState(): { labels: AnnotationLabels } {
  return { labels };
}

/** Update translated toolbar text without exposing a renderer control. */
export function setAnnotationLabels(next: Partial<AnnotationLabels>): void {
  labels = {
    ...labels,
    ...next,
    tools: { ...labels.tools, ...next.tools },
    widthOptions: { ...labels.widthOptions, ...next.widthOptions },
  };
  activeApp?.map.invoke("hosted-plugin.apply-state", {
    pluginId: ANNOTATIONS_PLUGIN_ID,
    state: runtimeState(),
  });
}

function activateAnnotations(
  app: GeoLibreAppAPI,
  context?: GeoLibrePluginActivationContext,
): boolean | Promise<boolean> {
  activeApp = app;
  return app.map.invoke("hosted-plugin.activate", {
    pluginId: ANNOTATIONS_PLUGIN_ID,
    position,
    collapsed: context?.collapsed,
    state: runtimeState(),
  });
}

function deactivateAnnotations(app: GeoLibreAppAPI): void {
  app.map.invoke("hosted-plugin.deactivate", { pluginId: ANNOTATIONS_PLUGIN_ID });
  if (activeApp === app) activeApp = null;
}

/** Renderer-neutral descriptor for the lazy MapLibre annotation runtime. */
export const maplibreAnnotationsPlugin: GeoLibrePlugin = {
  id: ANNOTATIONS_PLUGIN_ID,
  name: "Annotations",
  version: "0.1.0",
  activate: activateAnnotations,
  deactivate: deactivateAnnotations,
  getMapControlPosition: () => position,
  setMapControlPosition: (app, nextPosition) => {
    position = nextPosition;
    const applied = app.map.invoke("hosted-plugin.set-position", {
      pluginId: ANNOTATIONS_PLUGIN_ID,
      position: nextPosition,
    });
    return typeof applied === "boolean" ? applied : undefined;
  },
};
