import {
  DEFAULT_EFFECTS_SETTINGS,
  effectsSettingsEqual,
  HALO_EXTENT_MAX,
  HALO_EXTENT_MIN,
  HALO_OPACITY_MAX,
  HALO_OPACITY_MIN,
  normalizeEffectsSettings,
  type EffectsSettings,
} from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export {
  DEFAULT_EFFECTS_SETTINGS,
  HALO_EXTENT_MAX,
  HALO_EXTENT_MIN,
  HALO_OPACITY_MAX,
  HALO_OPACITY_MIN,
  normalizeEffectsSettings,
  type EffectsSettings,
};

/** Stable id for the lazy adapter-owned atmosphere renderer. */
export const EFFECTS_PLUGIN_ID = "maplibre-atmosphere-effects";

let activeApp: GeoLibreAppAPI | null = null;
let currentSettings: EffectsSettings = { ...DEFAULT_EFFECTS_SETTINGS };

function activateRuntime(app: GeoLibreAppAPI): boolean | Promise<boolean> {
  activeApp = app;
  return app.map.invoke("hosted-plugin.activate", {
    pluginId: EFFECTS_PLUGIN_ID,
    state: currentSettings,
  });
}

function applyRuntimeSettings(): void {
  activeApp?.map.invoke("hosted-plugin.apply-state", {
    pluginId: EFFECTS_PLUGIN_ID,
    state: currentSettings,
  });
}

function deactivateRuntime(): void {
  const runningApp = activeApp;
  if (runningApp) {
    runningApp.map.invoke("hosted-plugin.deactivate", { pluginId: EFFECTS_PLUGIN_ID });
  }
  activeApp = null;
}

/** Current atmosphere appearance settings (a copy callers may freely mutate). */
export function getEffectsSettings(): EffectsSettings {
  return { ...currentSettings };
}

/** Apply a partial settings update through the adapter runtime when it is live. */
export function setEffectsSettings(next: Partial<EffectsSettings>): boolean {
  const normalized = normalizeEffectsSettings(
    { ...currentSettings, ...next },
    DEFAULT_EFFECTS_SETTINGS,
  );
  if (effectsSettingsEqual(normalized, currentSettings)) return false;
  currentSettings = normalized;
  applyRuntimeSettings();
  return true;
}

/** Rebind the active-by-default renderer after project restore or map reinitialization. */
export function restoreEffects(app: GeoLibreAppAPI, active: boolean, settings?: unknown): void {
  currentSettings = normalizeEffectsSettings(settings, DEFAULT_EFFECTS_SETTINGS);
  if (active) {
    void activateRuntime(app);
    return;
  }
  if (activeApp) deactivateRuntime();
}

/** Renderer-neutral descriptor for the lazy MapLibre atmosphere runtime. */
export const maplibreEffectsPlugin: GeoLibrePlugin = {
  id: EFFECTS_PLUGIN_ID,
  name: "Atmospheric Effects",
  version: "1.0.0",
  activeByDefault: true,
  activate: activateRuntime,
  deactivate: deactivateRuntime,
  // Persist the appearance only when it differs from the defaults, so untouched
  // projects don't carry an effects settings blob.
  getProjectState: () =>
    effectsSettingsEqual(currentSettings, DEFAULT_EFFECTS_SETTINGS)
      ? undefined
      : { ...currentSettings },
  applyProjectState: (_app, state: unknown) => {
    const next = normalizeEffectsSettings(state, DEFAULT_EFFECTS_SETTINGS);
    if (effectsSettingsEqual(next, currentSettings)) return false;
    currentSettings = next;
    applyRuntimeSettings();
    return true;
  },
};
