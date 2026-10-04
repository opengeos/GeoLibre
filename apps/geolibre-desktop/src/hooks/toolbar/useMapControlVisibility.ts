import { useAppStore } from "@geolibre/core";
import { DEFAULT_BUILT_IN_CONTROL_VISIBILITY, type MapEngine } from "@geolibre/map";
import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  MAP_CONTROL_ITEMS,
  type ToolbarMapControl,
} from "../../components/layout/toolbar/constants";
import { readControlPreference, writeControlPreference } from "../../lib/control-preferences";
import { isMaptoolkitBasemapActive } from "../../lib/maptoolkit-basemap";
import {
  SCRIPT_MAP_CONTROL_EVENT,
  forgetScriptMapControl,
  type ScriptMapControlDetail,
} from "../../lib/scripting/ui-controls";

export type MapControlVisibility = Record<ToolbarMapControl, boolean>;

export interface MapControlVisibilityApi {
  /** The Controls menu's checkmarks: whether each built-in map control is shown. */
  controlsVisible: MapControlVisibility;
  /** Replaces the checkmarks without touching the map (e.g. New Project's reset). */
  setControlsVisible: Dispatch<SetStateAction<MapControlVisibility>>;
  /** Toggles a control on the live map and records the user's choice. */
  toggleMapControl: (control: ToolbarMapControl) => void;
}

/**
 * Owns the visibility of the optional built-in map controls (the Controls
 * menu's checkboxes) and keeps it in step with the live engine, scripted
 * toggles, the terrain preference, and the Maptoolkit attribution logo.
 *
 * @param mapControllerRef - The shell's live map engine.
 * @param mapReadyGeneration - Bumps when the engine is (re)published, so the
 *   chosen visibility is re-applied to a fresh engine.
 * @returns The visibility record, its setter, and the menu toggle handler.
 */
export function useMapControlVisibility(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration: number,
): MapControlVisibilityApi {
  const [controlsVisible, setControlsVisible] = useState<MapControlVisibility>(() =>
    MAP_CONTROL_ITEMS.reduce((acc, { id }) => {
      acc[id] =
        id === "terrain" || id === "maptoolkit-logo"
          ? DEFAULT_BUILT_IN_CONTROL_VISIBILITY[id]
          : readControlPreference(id, DEFAULT_BUILT_IN_CONTROL_VISIBILITY[id]);
      return acc;
    }, {} as MapControlVisibility),
  );
  // Restore optional chrome after startup and renderer replacement. Terrain is
  // project state and the Maptoolkit logo follows attribution requirements.
  useEffect(() => {
    for (const { id } of MAP_CONTROL_ITEMS) {
      if (id !== "terrain" && id !== "maptoolkit-logo")
        mapControllerRef.current?.setBuiltInControlVisible(id, controlsVisible[id]);
    }
  }, [mapControllerRef, mapReadyGeneration, controlsVisible]);

  // A script (the Jupyter widget's show_control/hide_control) toggles a control
  // on the map directly; mirror it here so the Controls menu checkmark agrees
  // and the effect above does not revert it on the next renderer swap. The
  // choice is per session, so unlike a menu toggle it is not written to the
  // device preference. Only the checkmark is mirrored here: re-applying the
  // control to a new map belongs to `useScriptControlRestore`, since this
  // toolbar is unmounted in `?maponly` embeds.
  useEffect(() => {
    const onScriptControl = (event: Event) => {
      const { control, visible } = (event as CustomEvent<ScriptMapControlDetail>).detail;
      setControlsVisible((current) =>
        current[control] === visible ? current : { ...current, [control]: visible },
      );
    };
    window.addEventListener(SCRIPT_MAP_CONTROL_EVENT, onScriptControl);
    return () => window.removeEventListener(SCRIPT_MAP_CONTROL_EVENT, onScriptControl);
  }, []);

  const terrainEnabled = useAppStore((state) => state.preferences.map.terrainEnabled);

  // Terrain is project state, unlike the other optional map chrome, so applying
  // it to the map lives in `useTerrainRestore` (DesktopShell) — this toolbar is
  // unmounted in `?maponly` embeds and must not own the restore. Only the
  // checkbox mirrors that state here.
  useEffect(() => {
    setControlsVisible((current) =>
      current.terrain === terrainEnabled ? current : { ...current, terrain: terrainEnabled },
    );
  }, [terrainEnabled]);

  const toggleMapControl = (control: ToolbarMapControl) => {
    const visible = !controlsVisible[control];
    const updated = mapControllerRef.current?.setBuiltInControlVisible(control, visible) ?? false;
    if (!updated) return;
    // An explicit user choice revokes an earlier scripted one, so
    // `useScriptControlRestore` stops forcing the scripted value back on the
    // next renderer swap or project load.
    forgetScriptMapControl(control);
    setControlsVisible((current) => ({ ...current, [control]: visible }));
    if (control !== "terrain" && control !== "maptoolkit-logo")
      writeControlPreference(control, visible);
    if (control === "terrain") {
      const { preferences, setPreferences } = useAppStore.getState();
      setPreferences({
        ...preferences,
        map: { ...preferences.map, terrainEnabled: visible },
      });
    }
  };

  // The Maptoolkit logo is Maptoolkit-basemap attribution, required by their
  // terms whenever a Maptoolkit basemap is in use (see isMaptoolkitBasemapActive)
  // and meaningless otherwise, so it tracks that flag automatically: shown the
  // moment a Maptoolkit basemap activates, hidden the moment it doesn't. The
  // imperative call is made directly in the effect body, not inside the
  // setControlsVisible updater — React (Strict Mode) runs a mount effect twice,
  // and add/removeMaptoolkitLogoControl report "already there"/"already gone" as
  // false, which isn't a failure; gating the state update on that return value
  // made the second of the two mount runs read as failed and leave the control
  // (and desired-vs-applied state) permanently out of sync. Calling it
  // unconditionally is safe: both helpers no-op when already in the desired
  // state.
  //
  // Deliberately NOT keyed on mapReadyGeneration (unlike
  // useVectorTileGeometryBackfill in the toolbar): that generation bumps on every
  // basemap style load, not just the controller's first readiness (see
  // MapCanvas's per-basemap-change `onControllerReadyRef` call), so including
  // it here re-fires this effect on every Maptoolkit-to-Maptoolkit style
  // switch — reapplying the flag and silently clobbering a manual toggle the
  // user made while that basemap stayed active. The effect depends only on
  // the flag itself (edge-triggered), so a manual toggle from the menu is left
  // alone until the flag actually flips; the trade-off is that an activation
  // landing before the controller exists (mapControllerRef.current still
  // null) is not retried, which our mount ordering does not otherwise hit.
  const maptoolkitBasemapActive = useAppStore((s) =>
    isMaptoolkitBasemapActive(s.basemapStyleUrl, s.layers),
  );
  useEffect(() => {
    mapControllerRef.current?.setBuiltInControlVisible("maptoolkit-logo", maptoolkitBasemapActive);
    setControlsVisible((current) =>
      current["maptoolkit-logo"] === maptoolkitBasemapActive
        ? current
        : { ...current, "maptoolkit-logo": maptoolkitBasemapActive },
    );
  }, [maptoolkitBasemapActive, mapControllerRef]);

  return { controlsVisible, setControlsVisible, toggleMapControl };
}
