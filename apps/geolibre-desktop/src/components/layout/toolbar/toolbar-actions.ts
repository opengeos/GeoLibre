import {
  closeDuckDBLayerPanel,
  closeEarthEnginePanel,
  closeMaplibreComponentControls,
  closePlanetaryComputerPanel,
  closeRasterLayerPanel,
  closeThreeDTilesLayerPanel,
  closeVectorLayerPanel,
  openDuckDBLayerPanel,
  openFlatGeobufAddVectorLayerPanel,
  openLidarLayerPanel,
  openPMTilesLayerPanel,
  openRasterLayerPanel,
  openRightPanel,
  openSplattingLayerPanel,
  openThreeDTilesLayerPanel,
  openVectorLayerPanel,
  openZarrLayerPanel,
  STAC_PLUGIN_ID,
} from "@geolibre/plugins";
import { rendererCapabilities, resetPrimaryCesiumBuiltInControlState } from "@geolibre/map";
import { getPluginManager } from "../../../hooks/usePlugins";
import { clearScriptMapControls } from "../../../lib/scripting/ui-controls";
import type { AddDataKind } from "../AddDataDialog";
import {
  ALL_BUILT_IN_CONTROL_IDS,
  type AddLayerHandlers,
  type AppApi,
  type MapControllerRef,
  NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS,
} from "./constants";

interface AddLayerHandlerDeps {
  appApi: AppApi;
  openAddDataKind: (kind: AddDataKind) => void;
  isActive: (id: string) => boolean;
  toggle: (id: string, appApi: AppApi) => void;
  setNetcdfDialogOpen: (open: boolean) => void;
}

/**
 * Builds the appApi-backed "add layer" handlers shared by the Add Data menu
 * and the command palette, so each panel opens identically from both.
 *
 * @param deps - The app API, the Add Data dialog opener, the plugin registry
 *   accessors, and the NetCDF dialog setter.
 * @returns One handler per layer source.
 */
export function createAddLayerHandlers({
  appApi,
  openAddDataKind,
  isActive,
  toggle,
  setNetcdfDialogOpen,
}: AddLayerHandlerDeps): AddLayerHandlers {
  return {
    vector: () => openVectorLayerPanel(appApi),
    raster: () =>
      !rendererCapabilities(appApi.getMapRenderer?.() ?? "maplibre").controlLayerPanels
        ? openAddDataKind("raster")
        : openRasterLayerPanel(appApi),
    stac: () => {
      if (isActive(STAC_PLUGIN_ID)) openRightPanel(STAC_PLUGIN_ID);
      else toggle(STAC_PLUGIN_ID, appApi);
    },
    flatGeobuf: () => openFlatGeobufAddVectorLayerPanel(appApi),
    pmtiles: () =>
      !rendererCapabilities(appApi.getMapRenderer?.() ?? "maplibre").controlLayerPanels
        ? openAddDataKind("pmtiles")
        : openPMTilesLayerPanel(appApi),
    // The ArcGIS view and the globe draw Zarr natively and have no Zarr control
    // to open, so they take the Add Data form instead.
    zarr: () =>
      rendererCapabilities(appApi.getMapRenderer?.() ?? "maplibre").nativeZarr
        ? openAddDataKind("zarr")
        : openZarrLayerPanel(appApi),
    netcdf: () => setNetcdfDialogOpen(true),
    lidar: () => openLidarLayerPanel(appApi),
    splatting: () => openSplattingLayerPanel(appApi),
    threeDTiles: () => openThreeDTilesLayerPanel(appApi),
    duckdb: () => openDuckDBLayerPanel(appApi),
  };
}

/**
 * Closes the runtime plugin panels and puts every built-in map control back to
 * its new-project default on the live engine. The caller resets the Controls
 * menu's checkmarks to match.
 *
 * @param appApi - The live app API the panels are driven through.
 * @param mapControllerRef - The live map engine.
 */
export function resetRuntimeControlsForNewProject(
  appApi: AppApi,
  mapControllerRef: MapControllerRef,
): void {
  closeMaplibreComponentControls(appApi);
  closeRasterLayerPanel(appApi);
  closeVectorLayerPanel(appApi);
  closePlanetaryComputerPanel(appApi);
  closeEarthEnginePanel(appApi);
  closeThreeDTilesLayerPanel(appApi);
  closeDuckDBLayerPanel(appApi);
  getPluginManager().restoreProjectState(null, appApi, {
    resetMissingSettings: true,
  });

  // The loops below reach only the live engine. The globe remembers its
  // controls' corners across mounts, so clear that too, or a corner moved in
  // the old project while Cesium was primary would come back the next time
  // the globe mounts in this one.
  resetPrimaryCesiumBuiltInControlState();
  for (const control of ALL_BUILT_IN_CONTROL_IDS) {
    mapControllerRef.current?.setBuiltInControlPosition(control, "top-right");
  }
  for (const control of ALL_BUILT_IN_CONTROL_IDS) {
    mapControllerRef.current?.setBuiltInControlVisible(
      control,
      NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS.has(control),
    );
  }
  // New Project resets every control to its default, so an earlier scripted
  // override is spent: without this `useScriptControlRestore` would re-apply
  // it to the live map on this same project-generation bump (parent effects
  // run after this child's) and desync the map from the checkmarks reset
  // right after this call. A widget project push does not come through here,
  // so it still keeps the controls a script set.
  clearScriptMapControls();
}
