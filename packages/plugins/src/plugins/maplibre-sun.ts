import {
  DEFAULT_SUN_SETTINGS,
  localDayStart,
  normalizeSunSettings,
  subsolarPoint,
  sunEquatorialPosition,
  sunPositionAt,
  sunSettingsEqual,
  SUN_MS_PER_DAY,
  SUN_SHADE_MAX,
  SUN_SHADE_MIN,
  SUN_SPEED_MAX,
  SUN_SPEED_MIN,
  type SunSettings,
} from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export {
  DEFAULT_SUN_SETTINGS,
  localDayStart,
  normalizeSunSettings,
  subsolarPoint,
  sunEquatorialPosition,
  sunPositionAt,
  SUN_SHADE_MAX,
  SUN_SHADE_MIN,
  SUN_SPEED_MAX,
  SUN_SPEED_MIN,
  type SunSettings,
};

/** Stable id for the lazy adapter-owned Sun Simulation runtime. */
export const SUN_PLUGIN_ID = "geolibre-sun";

let activeApp: GeoLibreAppAPI | null = null;
let panelVisible = false;
let settings: SunSettings = { ...DEFAULT_SUN_SETTINGS };

const panelListeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

function notifyPanel(): void {
  for (const listener of panelListeners) listener();
}

function notifyState(): void {
  for (const listener of stateListeners) listener();
}

function runtimeState(): void {
  activeApp?.map.invoke("hosted-plugin.apply-state", {
    pluginId: SUN_PLUGIN_ID,
    state: settings,
  });
}

function adoptRuntimeState(next: unknown): void {
  const normalized = normalizeSunSettings(next, DEFAULT_SUN_SETTINGS);
  if (sunSettingsEqual(normalized, settings)) return;
  settings = normalized;
  notifyState();
}

function activateRuntime(app: GeoLibreAppAPI): void {
  activeApp = app;
  void app.map.invoke("hosted-plugin.activate", {
    pluginId: SUN_PLUGIN_ID,
    state: settings,
    onStateChange: adoptRuntimeState,
  });
}

/** Open the panel and mount the adapter-owned renderer. Idempotent. */
export function openSunPanel(app: GeoLibreAppAPI): void {
  if (!panelVisible) {
    panelVisible = true;
    notifyPanel();
  }
  activateRuntime(app);
}

/** Close the panel, stop playback, and tear down the adapter-owned renderer. */
export function closeSunPanel(app: GeoLibreAppAPI | undefined = activeApp ?? undefined): void {
  if (settings.playing) {
    settings = { ...settings, playing: false };
    notifyState();
    runtimeState();
  }
  app?.map.invoke("hosted-plugin.deactivate", { pluginId: SUN_PLUGIN_ID });
  activeApp = null;
  if (panelVisible) {
    panelVisible = false;
    notifyPanel();
  }
}

export function isSunPanelVisible(): boolean {
  return panelVisible;
}

export function subscribeSunPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

/** Current simulation settings (a copy callers may freely read). */
export function getSunSettings(): SunSettings {
  return { ...settings };
}

/** Stable settings reference for React's `useSyncExternalStore`. */
export function getSunSettingsSnapshot(): SunSettings {
  return settings;
}

export function subscribeSunSettings(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Apply a partial setting update through the adapter runtime when it is live. */
export function setSunSettings(next: Partial<SunSettings>): boolean {
  const normalized = normalizeSunSettings({ ...settings, ...next }, DEFAULT_SUN_SETTINGS);
  if (sunSettingsEqual(normalized, settings)) return false;
  settings = normalized;
  runtimeState();
  notifyState();
  return true;
}

/**
 * Advance the clock for tests and non-renderer callers. Live animation advances
 * inside the adapter runtime and reports its resulting state through the same
 * typed hosted-runtime callback.
 */
export function advanceSunClock(deltaMs: number): void {
  const dayStart = localDayStart(settings.dateMs);
  let dateMs = settings.dateMs + deltaMs;
  let playing = settings.playing;
  if (dateMs >= dayStart + SUN_MS_PER_DAY) {
    if (settings.loop) {
      dateMs = dayStart + ((dateMs - dayStart) % SUN_MS_PER_DAY);
    } else {
      dateMs = dayStart + SUN_MS_PER_DAY - 1;
      playing = false;
    }
  }
  settings = { ...settings, dateMs, playing };
  runtimeState();
  notifyState();
}

/** Restore persisted state and open/close the panel according to its flag. */
export function restoreSun(app: GeoLibreAppAPI, state?: unknown): boolean {
  const next = normalizeSunSettings(state, DEFAULT_SUN_SETTINGS);
  const shouldOpen = Boolean(
    state && typeof state === "object" && (state as { open?: unknown }).open,
  );
  const settingsChanged = !sunSettingsEqual(next, settings);
  if (settingsChanged) {
    settings = next;
    notifyState();
  }
  const wasVisible = panelVisible;
  if (shouldOpen) openSunPanel(app);
  else closeSunPanel(app);
  return settingsChanged || panelVisible !== wasVisible;
}

/** Rebind an already-open panel after the host reinitializes its map engine. */
export function reattachSun(app: GeoLibreAppAPI): void {
  if (panelVisible) activateRuntime(app);
}

/** Renderer-neutral descriptor for the lazy MapLibre Sun runtime. */
export const maplibreSunPlugin: GeoLibrePlugin = {
  id: SUN_PLUGIN_ID,
  name: "Sun Simulation",
  version: "1.0.0",
  activeByDefault: false,
  activate: openSunPanel,
  deactivate: closeSunPanel,
  getProjectState: () => {
    if (!panelVisible && sunSettingsEqual(settings, DEFAULT_SUN_SETTINGS)) return undefined;
    return { open: panelVisible, ...settings };
  },
  applyProjectState: (app, state: unknown) => restoreSun(app, state),
};
