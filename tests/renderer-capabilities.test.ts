import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rendererAppliesOpacity, type MapRendererKind } from "@geolibre/core";
import { ARCGIS_CAPABILITIES, ARCGIS_DECK_CAPABILITIES } from "../packages/map/src/arcgis-engine";
import { CESIUM_CAPABILITIES, CESIUM_PANE_CAPABILITIES } from "../packages/map/src/cesium-engine";
import { MAPBOX_CAPABILITIES } from "../packages/map/src/mapbox-engine";
import { MAPLIBRE_CAPABILITIES, type MapEngineCapabilities } from "../packages/map/src/map-engine";
import { rendererCapabilities } from "../packages/map/src/renderer-capabilities";
import { isNativeZarrRenderer } from "../packages/plugins/src/plugins/components/zarr";

// Issue #2858 replaced `primaryRenderer === "…"` checks with capability flags.
// Each row is the renderer-name check a flag replaced, so a flag that drifts
// from what the old check meant fails here instead of silently changing a menu.
const RENDERERS: MapRendererKind[] = ["maplibre", "mapbox", "cesium", "arcgis"];

/** Every capability object an engine of `renderer` can publish. */
function variants(renderer: MapRendererKind): MapEngineCapabilities[] {
  switch (renderer) {
    case "cesium":
      return [CESIUM_CAPABILITIES, CESIUM_PANE_CAPABILITIES];
    case "mapbox":
      return [MAPBOX_CAPABILITIES];
    case "arcgis":
      return [ARCGIS_CAPABILITIES, ARCGIS_DECK_CAPABILITIES];
    default:
      return [MAPLIBRE_CAPABILITIES];
  }
}

const REPLACED_CHECKS: Array<{
  flag: string;
  read: (capabilities: MapEngineCapabilities) => boolean;
  old: (renderer: MapRendererKind) => boolean;
}> = [
  {
    flag: "nativeZarr",
    read: (c) => c.nativeZarr,
    old: (r) => r === "arcgis" || r === "cesium",
  },
  {
    flag: "nativeDataSources",
    read: (c) => c.nativeDataSources,
    old: (r) => r === "cesium",
  },
  {
    flag: "deferredEngineReady",
    read: (c) => c.deferredEngineReady,
    old: (r) => r === "mapbox" || r === "arcgis",
  },
  {
    flag: "measureTool",
    read: (c) => c.measureTool,
    old: (r) => r !== "arcgis",
  },
  {
    flag: "controlLayerPanels",
    read: (c) => c.controlLayerPanels,
    old: (r) => r !== "arcgis",
  },
  {
    // useRendererHandoff and the screenshot-readiness gate.
    flag: "nativeMapInstance",
    read: (c) => c.nativeMapInstance,
    old: (r) => r === "maplibre",
  },
];

describe("capability flags match the renderer checks they replaced", () => {
  for (const { flag, read, old } of REPLACED_CHECKS) {
    it(flag, () => {
      for (const renderer of RENDERERS) {
        for (const capabilities of variants(renderer)) {
          assert.equal(read(capabilities), old(renderer), `${flag} on ${renderer}`);
        }
      }
    });
  }

  it("restores 3D Tiles and LiDAR off the native path on Mapbox and a deck-capable ArcGIS view", () => {
    // usePluginStateRestore: `kind === "mapbox" || (kind === "arcgis" && deckOverlay)`.
    for (const renderer of RENDERERS) {
      for (const c of variants(renderer)) {
        const old = renderer === "mapbox" || (renderer === "arcgis" && c.deckOverlay);
        assert.equal(c.deckOverlay && !c.nativeMapInstance, old, renderer);
      }
    }
  });

  // Both live where the @geolibre/map index cannot be imported, so they mirror
  // the flag by name instead of reading it.
  it("keeps @geolibre/core's Zarr opacity rule in step with nativeZarr", () => {
    for (const renderer of RENDERERS) {
      assert.equal(
        rendererAppliesOpacity({ type: "zarr" }, renderer),
        rendererCapabilities(renderer).nativeZarr,
        renderer,
      );
    }
  });

  it("keeps the Zarr plugin's native-renderer check in step with nativeZarr", () => {
    for (const renderer of RENDERERS) {
      assert.equal(
        isNativeZarrRenderer(renderer),
        rendererCapabilities(renderer).nativeZarr,
        renderer,
      );
    }
  });
});

describe("rendererCapabilities", () => {
  it("answers with each engine's own frozen capability object", () => {
    assert.equal(rendererCapabilities("maplibre"), MAPLIBRE_CAPABILITIES);
    assert.equal(rendererCapabilities("mapbox"), MAPBOX_CAPABILITIES);
    assert.equal(rendererCapabilities("cesium"), CESIUM_CAPABILITIES);
    assert.equal(rendererCapabilities("cesium", "mercator"), CESIUM_CAPABILITIES);
  });

  it("follows the projection on ArcGIS, whose globe has no deck.gl overlay", () => {
    assert.equal(rendererCapabilities("arcgis", "globe"), ARCGIS_CAPABILITIES);
    assert.equal(rendererCapabilities("arcgis", "mercator"), ARCGIS_DECK_CAPABILITIES);
    assert.equal(rendererCapabilities("arcgis"), ARCGIS_DECK_CAPABILITIES);
  });

  it("declares every flag on every engine", () => {
    const keys = Object.keys(MAPLIBRE_CAPABILITIES).sort();
    for (const renderer of RENDERERS) {
      for (const capabilities of variants(renderer)) {
        assert.deepEqual(Object.keys(capabilities).sort(), keys, renderer);
        for (const key of keys) {
          assert.equal(
            typeof capabilities[key as keyof MapEngineCapabilities],
            "boolean",
            `${renderer}.${key}`,
          );
        }
      }
    }
  });
});
