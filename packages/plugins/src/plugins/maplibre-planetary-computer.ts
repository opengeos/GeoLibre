import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../types";

/** Stable id for the lazy adapter-owned Planetary Computer control runtime. */
export const PLANETARY_COMPUTER_RUNTIME_ID = "maplibre-gl-planetary-computer";

function hasPlanetaryComputerLayers(): boolean {
  return useAppStore
    .getState()
    .layers.some(
      (layer) =>
        layer.type === "raster" &&
        layer.metadata.sourceKind === "planetary-computer-raster" &&
        layer.metadata.externalNativeLayer === true,
    );
}

/** Open (or reveal) the adapter-owned Planetary Computer control. */
export function openPlanetaryComputerPanel(app: GeoLibreAppAPI): void {
  void Promise.resolve(
    app.map.invoke("hosted-plugin.activate", {
      pluginId: PLANETARY_COMPUTER_RUNTIME_ID,
      state: { openPanel: true },
    }),
  ).catch((error: unknown) => {
    console.error("Planetary Computer control failed to open.", error);
  });
}

/** Tear down the adapter-owned control, for example during host unmount. */
export function closePlanetaryComputerPanel(app: GeoLibreAppAPI): void {
  app.map.invoke("hosted-plugin.deactivate", { pluginId: PLANETARY_COMPUTER_RUNTIME_ID });
}

/** Replay saved Planetary Computer store layers through the current map adapter. */
export function restorePlanetaryComputerLayers(app: GeoLibreAppAPI): void {
  if (!hasPlanetaryComputerLayers()) return;
  void Promise.resolve(
    app.map.invoke("hosted-plugin.activate", {
      pluginId: PLANETARY_COMPUTER_RUNTIME_ID,
      state: { restoreLayers: true },
    }),
  ).catch((error: unknown) => {
    console.error("Planetary Computer layer restore failed.", error);
  });
}
