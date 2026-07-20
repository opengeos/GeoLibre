import type { TimeBinding } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

/** Stable id for the lazy adapter-owned Time Slider runtime. */
export const TIME_SLIDER_PLUGIN_ID = "maplibre-gl-time-slider";

let timeSliderPosition: GeoLibreMapControlPosition = "bottom-left";
let activeApp: GeoLibreAppAPI | null = null;
let savedProjectState: unknown;

function cloneProjectState(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isSafeSourceUrl(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return true;
  return /^https?:\/\//i.test(value);
}

/** Validate only the persisted boundary shape; the adapter validates native options. */
function normalizeTimeSliderProjectState(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    startDate?: unknown;
    endDate?: unknown;
    granularity?: unknown;
    currentDate?: unknown;
    sources?: unknown;
  };
  const valid =
    typeof candidate.startDate === "string" &&
    (candidate.endDate == null || typeof candidate.endDate === "string") &&
    typeof candidate.granularity === "string" &&
    (candidate.currentDate === undefined || typeof candidate.currentDate === "string") &&
    Array.isArray(candidate.sources) &&
    candidate.sources.every((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return false;
      const spec = source as {
        id?: unknown;
        url?: unknown;
        tiles?: unknown;
        data?: unknown;
        baseUrl?: unknown;
      };
      return (
        typeof spec.id === "string" &&
        isSafeSourceUrl(spec.url) &&
        isSafeSourceUrl(spec.tiles) &&
        isSafeSourceUrl(spec.data) &&
        isSafeSourceUrl(spec.baseUrl)
      );
    });
  if (!valid) return null;
  const normalized = cloneProjectState(value) as Record<string, unknown>;
  // The native control represents an open end by omitting the field. Normalize
  // a hand-authored `null` before project persistence so the representation is
  // stable across save/restore.
  if (normalized.endDate === null) delete normalized.endDate;
  return normalized;
}

function adoptRuntimeState(next: unknown): void {
  savedProjectState = normalizeTimeSliderProjectState(next) ?? undefined;
}

/** Last serializable Time Slider configuration, or undefined while inactive. */
export function getTimeSliderProjectState(): unknown {
  return cloneProjectState(savedProjectState);
}

function activateTimeSlider(app: GeoLibreAppAPI): boolean | Promise<boolean> {
  activeApp = app;
  return app.map.invoke("hosted-plugin.activate", {
    pluginId: TIME_SLIDER_PLUGIN_ID,
    position: timeSliderPosition,
    state: savedProjectState,
    onStateChange: adoptRuntimeState,
  });
}

function deactivateTimeSlider(app: GeoLibreAppAPI): void {
  const state = app.map.invoke("hosted-plugin.get-state", { pluginId: TIME_SLIDER_PLUGIN_ID });
  adoptRuntimeState(state);
  app.map.invoke("hosted-plugin.deactivate", { pluginId: TIME_SLIDER_PLUGIN_ID });
  if (activeApp === app) activeApp = null;
}

/** Renderer-neutral descriptor for the lazy Time Slider runtime. */
export const maplibreTimeSliderPlugin: GeoLibrePlugin = {
  id: TIME_SLIDER_PLUGIN_ID,
  name: "Time Slider",
  version: "1.0.3",
  // The saved config owns the dock's collapse state during project restore.
  restoresPanelCollapseState: true,
  activate: activateTimeSlider,
  deactivate: deactivateTimeSlider,
  getMapControlPosition: () => timeSliderPosition,
  setMapControlPosition: (app, position) => {
    timeSliderPosition = position;
    return app.map.invoke("hosted-plugin.set-position", {
      pluginId: TIME_SLIDER_PLUGIN_ID,
      position,
    });
  },
  getProjectState: () => getTimeSliderProjectState(),
  applyProjectState: (app, state) => {
    const nextState = normalizeTimeSliderProjectState(state);
    if (!nextState) {
      savedProjectState = undefined;
      if (activeApp !== app) return false;
      return app.map.invoke("hosted-plugin.apply-state", {
        pluginId: TIME_SLIDER_PLUGIN_ID,
        state: undefined,
      });
    }
    savedProjectState = nextState;
    if (activeApp !== app) return true;
    return app.map.invoke("hosted-plugin.apply-state", {
      pluginId: TIME_SLIDER_PLUGIN_ID,
      state: savedProjectState,
    });
  },
};

/** Read a shared time binding from layer metadata without a renderer dependency. */
export function getLayerTimeBinding(layer: {
  metadata?: Record<string, unknown>;
}): TimeBinding | undefined {
  const binding = layer.metadata?.timeBinding as TimeBinding | undefined;
  return binding && typeof binding.property === "string" ? binding : undefined;
}
