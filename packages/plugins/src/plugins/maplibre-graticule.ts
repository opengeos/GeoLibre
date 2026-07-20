import {
  DEFAULT_GRATICULE_LABELS,
  DEFAULT_GRATICULE_SETTINGS,
  graticuleSettingsEqual,
  normalizeGraticuleSettings,
  type GraticuleLabels,
  type GraticuleSettings,
} from "@geolibre/core";
import type { MapEngineRightPanelHost } from "@geolibre/map";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/** Stable project/plugin identifier retained while its adapter runtime migrates. */
export const GRATICULE_PLUGIN_ID = "maplibre-gl-graticule";

/** Label-layer id used by print layout to keep edge labels inside its capture. */
export const GRATICULE_LABEL_LAYER_ID = "geolibre-graticule-labels-layer";

export {
  autoMetricStep,
  DEFAULT_GRATICULE_LABELS,
  DEFAULT_GRATICULE_SETTINGS,
  formatEasting,
  formatLat,
  formatLon,
  formatNorthing,
  normalizeGraticuleSettings,
  utmLatBand,
  utmZoneDesignation,
  utmZoneForLon,
  type GraticuleGridType,
  type GraticuleLabelEdges,
  type GraticuleLabelFormat,
  type GraticuleLabels,
  type GraticuleSettings,
} from "@geolibre/core";

let settings: GraticuleSettings = { ...DEFAULT_GRATICULE_SETTINGS };
let labels: GraticuleLabels = { ...DEFAULT_GRATICULE_LABELS };
let activeApp: GeoLibreAppAPI | null = null;

interface GraticuleRuntimeState {
  readonly settings?: unknown;
  readonly labels?: Partial<GraticuleLabels>;
}

function runtimeState(): GraticuleRuntimeState {
  return { settings: { ...settings }, labels: { ...labels } };
}

function createRightPanelHost(app: GeoLibreAppAPI): MapEngineRightPanelHost | undefined {
  const register = app.registerRightPanel;
  const open = app.openRightPanel;
  if (!register || !open) return undefined;
  return {
    register: (panel) => register(panel),
    open: (id) => open(id),
  };
}

function applyRuntimeSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as GraticuleRuntimeState;
  if (state.settings === undefined) return false;
  const next = normalizeGraticuleSettings(state.settings);
  if (graticuleSettingsEqual(settings, next)) return false;
  settings = next;
  return true;
}

function syncRuntime(): void {
  activeApp?.map.invoke("hosted-plugin.apply-state", {
    pluginId: GRATICULE_PLUGIN_ID,
    state: runtimeState(),
  });
}

/** Current renderer-neutral grid settings, for project state and integrations. */
export function getGraticuleSettings(): GraticuleSettings {
  return { ...settings };
}

/** Update renderer-neutral settings and forward them only through MapEngine. */
export function setGraticuleSettings(patch: Partial<GraticuleSettings>): void {
  settings = normalizeGraticuleSettings({ ...settings, ...patch });
  syncRuntime();
}

/** Update host-localized copy without importing a renderer control. */
export function setGraticuleLabels(next: Partial<GraticuleLabels>): void {
  labels = { ...labels, ...next };
  syncRuntime();
}

function activateGraticule(app: GeoLibreAppAPI): boolean | Promise<boolean> {
  activeApp = app;
  return app.map.invoke("hosted-plugin.activate", {
    pluginId: GRATICULE_PLUGIN_ID,
    state: runtimeState(),
    onStateChange: applyRuntimeSettings,
    rightPanelHost: createRightPanelHost(app),
  });
}

function deactivateGraticule(app: GeoLibreAppAPI): void {
  app.map.invoke("hosted-plugin.deactivate", { pluginId: GRATICULE_PLUGIN_ID });
  if (activeApp === app) activeApp = null;
}

/** Renderer-neutral descriptor for the lazy MapLibre Gridlines runtime. */
export const maplibreGraticulePlugin: GeoLibrePlugin = {
  id: GRATICULE_PLUGIN_ID,
  name: "Gridlines",
  version: "0.1.0",
  activate: activateGraticule,
  deactivate: deactivateGraticule,
  getProjectState: () =>
    graticuleSettingsEqual(settings, DEFAULT_GRATICULE_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (app, state) => {
    const next = normalizeGraticuleSettings(state);
    if (graticuleSettingsEqual(settings, next)) return false;
    settings = next;
    if (activeApp !== app) return true;
    return app.map.invoke("hosted-plugin.apply-state", {
      pluginId: GRATICULE_PLUGIN_ID,
      state: runtimeState(),
    });
  },
};
