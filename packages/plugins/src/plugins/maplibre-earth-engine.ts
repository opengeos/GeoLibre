import type { GeoLibreAppAPI } from "../types";

/** Stable id for the lazy adapter-owned Earth Engine control runtime. */
export const EARTH_ENGINE_RUNTIME_ID = "maplibre-gl-earth-engine";

type EarthEnginePanelListener = () => void;

let activeApp: GeoLibreAppAPI | null = null;
let visible = false;
const listeners = new Set<EarthEnginePanelListener>();

function setVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

function adoptRuntimeState(state: unknown): void {
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  const nextVisible = (state as { visible?: unknown }).visible;
  if (typeof nextVisible === "boolean") setVisible(nextVisible);
}

function activateRuntime(app: GeoLibreAppAPI): void {
  activeApp = app;
  const activation = app.map.invoke("hosted-plugin.activate", {
    pluginId: EARTH_ENGINE_RUNTIME_ID,
    onStateChange: adoptRuntimeState,
  });
  void Promise.resolve(activation)
    .then((opened) => {
      if (opened !== false) return;
      if (activeApp === app) activeApp = null;
      setVisible(false);
    })
    .catch((error: unknown) => {
      console.error("Earth Engine control failed to open.", error);
      if (activeApp === app) activeApp = null;
      setVisible(false);
    });
}

/** Open (or reveal) the adapter-owned Earth Engine control. */
export function openEarthEnginePanel(app: GeoLibreAppAPI): void {
  activateRuntime(app);
}

/** Toggle the visible Earth Engine panel without exposing a native control. */
export function toggleEarthEnginePanel(app: GeoLibreAppAPI): void {
  if (!visible) {
    openEarthEnginePanel(app);
    return;
  }
  if (app.map.invoke("earth-engine.hide", undefined)) setVisible(false);
}

/** Tear down the adapter-owned control, for example during host unmount. */
export function closeEarthEnginePanel(app: GeoLibreAppAPI): void {
  app.map.invoke("hosted-plugin.deactivate", { pluginId: EARTH_ENGINE_RUNTIME_ID });
  if (activeApp === app) activeApp = null;
  setVisible(false);
}

/** Whether the adapter has reported the Earth Engine control as visible. */
export function isEarthEnginePanelVisible(): boolean {
  return visible;
}

/** Subscribe to renderer-neutral Earth Engine panel visibility. */
export function subscribeEarthEnginePanel(listener: EarthEnginePanelListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
