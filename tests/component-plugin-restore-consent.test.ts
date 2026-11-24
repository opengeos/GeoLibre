import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderHook } from "@testing-library/react";
import type { MapEngine } from "@geolibre/map";
import { REVERSE_GEOCODE_PLUGIN_ID } from "@geolibre/plugins/plugin-ids";

const { usePluginStateRestore } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/usePluginStateRestore");
const { rendererCapabilities } = await import("@geolibre/map");
const { getPluginManager } = await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { createAppAPI } = await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { recordReverseGeocodeConsent } =
  await import("../apps/geolibre-desktop/src/lib/reverse-geocode-consent");

for (const renderer of ["maplibre", "mapbox", "cesium", "arcgis"] as const) {
  for (const consent of [false, true]) {
    it(`${consent ? "allows" : "cancels"} saved reverse-geocode activation with consent=${consent} on ${renderer}`, () => {
      if (consent) recordReverseGeocodeConsent();
      useAppStore.setState({
        primaryRenderer: renderer,
        projectPlugins: {
          manifestUrls: [],
          activePluginIds: [REVERSE_GEOCODE_PLUGIN_ID],
          mapControlPositions: {},
          settings: {},
        },
      });
      const engine = {
        kind: renderer,
        capabilities: rendererCapabilities(renderer),
        getMap: () => null,
      } as unknown as MapEngine;
      const mapControllerRef = { current: engine };
      const enforceViewerPlugins = () => {};
      const hook = renderHook(() =>
        usePluginStateRestore({
          mapControllerRef,
          externalPluginsReady: true,
          enforceViewerPlugins,
          mapReadyGeneration: 1,
          projectGeneration: useAppStore.getState().projectGeneration,
          projectUrlSettled: true,
        }),
      );
      try {
        assert.equal(getPluginManager().isActive(REVERSE_GEOCODE_PLUGIN_ID), consent);
      } finally {
        hook.unmount();
        getPluginManager().deactivate(REVERSE_GEOCODE_PLUGIN_ID, createAppAPI(mapControllerRef));
      }
    });
  }
}
