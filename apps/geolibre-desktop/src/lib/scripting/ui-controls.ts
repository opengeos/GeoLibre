import { IDENTIFY_ALL_LAYERS_ID, resolveIdentifyTarget, useAppStore } from "@geolibre/core";
import type { BuiltInMapControl } from "@geolibre/map";

// Scripted control of UI state that is not part of the project: which layer
// Identify is armed on, and which map controls and toolbar panels are shown.
// The Jupyter widget replays these on load, so a notebook can open a map with
// popups armed and the bookmark or search panel already up (discussion #2600).
// A project can also carry them as its startup `interaction` block, which
// `useProjectInteractionRestore` applies through the same commands (#2688).

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
 * Built-in map controls a script has shown or hidden this session.
 *
 * Kept at module scope rather than in the toolbar because `?maponly` embeds
 * never mount the toolbar, and a renderer swap or project load drops whatever
 * the previous controller had mounted. `useScriptControlRestore` replays this
 * record onto each new controller, the same split `useTerrainRestore` uses for
 * terrain. It also covers a script that runs before the controller exists: the
 * map controller is created asynchronously, so a command flushed right after
 * `geolibre:ready` can find none.
 */
const scriptMapControls = new Map<ScriptableMapControl, boolean>();

/**
 * Record a script's desired visibility for a built-in map control.
 *
 * @param control - The control the script addressed.
 * @param visible - Whether the script asked for it to be shown.
 */
export function recordScriptMapControl(control: ScriptableMapControl, visible: boolean): void {
  scriptMapControls.set(control, visible);
}

/**
 * Read every control visibility a script has set this session.
 *
 * @returns The recorded control/visibility pairs, oldest first.
 */
export function getScriptMapControls(): readonly (readonly [ScriptableMapControl, boolean])[] {
  return [...scriptMapControls];
}

/**
 * Drop a script's recorded override for one control.
 *
 * Called when the user toggles that control from the Controls menu: an explicit
 * user choice revokes an earlier scripted one, so the replay must stop forcing
 * the scripted value back on the next map or project change.
 *
 * @param control - The control the user toggled. Ignored when no script has
 *   touched it, or when it is not scriptable at all (terrain, the Maptoolkit
 *   logo).
 */
export function forgetScriptMapControl(control: BuiltInMapControl): void {
  if (isScriptableMapControl(control)) scriptMapControls.delete(control);
}

/**
 * Forget every recorded control.
 *
 * Called when the user starts a New Project, which resets all controls to their
 * defaults and so spends any scripted override, and by tests.
 */
export function clearScriptMapControls(): void {
  scriptMapControls.clear();
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
 * Arm Identify on one layer, on several, on every visible layer, or turn it off.
 *
 * {@link SCRIPT_IDENTIFY_ALL} is matched before `layerId` is resolved against
 * the project, so a layer whose id is literally `"all"` cannot be targeted on
 * its own. Generated ids are nanoid-style, so only a hand-authored project can
 * reach that, and the sentinel is part of the documented API.
 *
 * A list limits the all-layers mode to those layers (issue #2688), so clicking
 * the map opens popups for them and not for base or context layers.
 *
 * @param layerId - A layer id, a list of layer ids, {@link SCRIPT_IDENTIFY_ALL},
 *   or null to disarm.
 * @returns The resulting Identify target in script terms (see
 *   {@link getScriptIdentify}).
 * @throws If `layerId` is not a string, a list of strings, or null, or names a
 *   layer that does not exist.
 */
export function setScriptIdentify(layerId: unknown): string | string[] | null {
  const state = useAppStore.getState();
  if (layerId === null || layerId === undefined) {
    state.setIdentifyLayer(null);
    return null;
  }
  const ids = Array.isArray(layerId) ? layerId : [layerId];
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id)) {
    throw new Error('setIdentify: layerId must be a layer id, a list of layer ids, "all", or null');
  }
  if (layerId === SCRIPT_IDENTIFY_ALL) {
    state.setIdentifyLayer(IDENTIFY_ALL_LAYERS_ID);
    return SCRIPT_IDENTIFY_ALL;
  }
  const missing = (ids as string[]).find((id) => !state.layers.some((layer) => layer.id === id));
  if (missing !== undefined) throw new Error(`No layer with id "${missing}"`);
  state.setIdentifyState(
    resolveIdentifyTarget(
      ids as string[],
      state.layers.map((layer) => layer.id),
    ),
  );
  return getScriptIdentify();
}

/**
 * Read which layers Identify is armed on, in script terms.
 *
 * @returns A layer id, a list of layer ids when the all-layers mode is limited
 *   to several, {@link SCRIPT_IDENTIFY_ALL}, or null when disarmed.
 */
export function getScriptIdentify(): string | string[] | null {
  const { identifyLayerId: id, identifyLayerIds } = useAppStore.getState();
  if (id !== IDENTIFY_ALL_LAYERS_ID) return id;
  return identifyLayerIds ? [...identifyLayerIds] : SCRIPT_IDENTIFY_ALL;
}
