import { IDENTIFY_ALL_LAYERS_ID, useAppStore } from "@geolibre/core";
import type { BuiltInMapControl } from "@geolibre/map";

// Scripted control of UI state that is not part of the project: which layer
// Identify is armed on, and which map controls and toolbar panels are shown.
// The Jupyter widget replays these on load, so a notebook can open a map with
// popups armed and the bookmark or search panel already up (discussion #2600).

/** The value a script passes to arm Identify on every visible queryable layer. */
export const SCRIPT_IDENTIFY_ALL = "all";

/**
 * Built-in map controls a script may show or hide. Terrain is project state
 * (set through the project's preferences) and the Maptoolkit logo follows the
 * basemap's attribution terms, so neither is scriptable here.
 */
export const SCRIPTABLE_MAP_CONTROLS = [
  "navigation",
  "fullscreen",
  "compass",
  "geolocate",
  "globe",
  "scale",
  "attribution",
  "logo",
] as const satisfies readonly BuiltInMapControl[];

export type ScriptableMapControl = (typeof SCRIPTABLE_MAP_CONTROLS)[number];

/** Toolbar panels (Controls menu) a script may open or close. */
export const SCRIPTABLE_PANELS = ["bookmark", "search", "measure", "minimap", "print"] as const;

export type ScriptablePanel = (typeof SCRIPTABLE_PANELS)[number];

/**
 * Fired when a script changes a built-in map control, so the toolbar can keep
 * its checkmarks (and the state it re-applies on a renderer swap) in step.
 */
export const SCRIPT_MAP_CONTROL_EVENT = "geolibre-script-map-control";

/** Detail of {@link SCRIPT_MAP_CONTROL_EVENT}. */
export interface ScriptMapControlDetail {
  control: ScriptableMapControl;
  visible: boolean;
}

/**
 * Whether a name is a scriptable built-in map control.
 *
 * @param name - The control name a script passed.
 * @returns True for one of {@link SCRIPTABLE_MAP_CONTROLS}.
 */
export function isScriptableMapControl(name: unknown): name is ScriptableMapControl {
  return (SCRIPTABLE_MAP_CONTROLS as readonly unknown[]).includes(name);
}

/**
 * Whether a name is a scriptable toolbar panel.
 *
 * @param name - The panel name a script passed.
 * @returns True for one of {@link SCRIPTABLE_PANELS}.
 */
export function isScriptablePanel(name: unknown): name is ScriptablePanel {
  return (SCRIPTABLE_PANELS as readonly unknown[]).includes(name);
}

/**
 * Arm Identify on one layer, on every visible layer, or turn it off.
 *
 * @param layerId - A layer id, {@link SCRIPT_IDENTIFY_ALL}, or null to disarm.
 * @returns The store's resulting `identifyLayerId` in script terms.
 * @throws If `layerId` is not a string or null, or names no layer.
 */
export function setScriptIdentify(layerId: unknown): string | null {
  const state = useAppStore.getState();
  if (layerId === null || layerId === undefined) {
    state.setIdentifyLayer(null);
    return null;
  }
  if (typeof layerId !== "string" || !layerId) {
    throw new Error('setIdentify: layerId must be a layer id, "all", or null');
  }
  if (layerId === SCRIPT_IDENTIFY_ALL) {
    state.setIdentifyLayer(IDENTIFY_ALL_LAYERS_ID);
    return SCRIPT_IDENTIFY_ALL;
  }
  if (!state.layers.some((layer) => layer.id === layerId)) {
    throw new Error(`No layer with id "${layerId}"`);
  }
  state.setIdentifyLayer(layerId);
  return layerId;
}

/**
 * Read which layer Identify is armed on, in script terms.
 *
 * @returns A layer id, {@link SCRIPT_IDENTIFY_ALL}, or null when disarmed.
 */
export function getScriptIdentify(): string | null {
  const id = useAppStore.getState().identifyLayerId;
  return id === IDENTIFY_ALL_LAYERS_ID ? SCRIPT_IDENTIFY_ALL : id;
}
