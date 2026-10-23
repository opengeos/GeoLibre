import { act, cleanup, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { TerrainSettingsDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/TerrainSettingsDialog");
const { CESIUM_CAPABILITIES, TERRAIN_SETTINGS_EVENT } = await import("@geolibre/map");

type RuntimeWindow = { __GEOLIBRE_RUNTIME_ENV__?: Record<string, string> };

/**
 * A Cesium-like engine that records the order of terrain-source calls.
 *
 * @param options - `cog` is the active COG URL, `ion` the selected Ion asset,
 *   and `clearCog` what `setTerrainCogSource(null)` resolves to.
 * @returns The fake engine and its call log.
 */
function fakeEngine(options: { cog?: string | null; ion?: number | null; clearCog?: boolean }) {
  const calls: string[] = [];
  let cog = options.cog ?? null;
  let ion = options.ion ?? null;
  const engine = {
    kind: "cesium",
    capabilities: CESIUM_CAPABILITIES,
    getTerrainExaggeration: () => 1,
    setTerrainExaggeration: () => {},
    getTerrainCogSource: () => cog,
    hasCustomTerrainSource: () => cog !== null,
    getTerrainIonAssetId: () => ion,
    async setTerrainCogSource(source: string | Blob | null) {
      calls.push(`cog:${source === null ? "null" : String(source)}`);
      if (source === null && options.clearCog === false) return false;
      if (source === "broken.tif") throw new Error("404");
      cog = typeof source === "string" ? source : null;
      return true;
    },
    async setTerrainIonAssetId(assetId: number | null) {
      calls.push(`ion:${assetId}`);
      ion = assetId;
      return true;
    },
  };
  return { engine, calls };
}

function renderDialog(engine: object) {
  render(createElement(TerrainSettingsDialog, { mapControllerRef: { current: engine as never } }));
  act(() => {
    window.dispatchEvent(new Event(TERRAIN_SETTINGS_EVENT));
  });
}

function savedIonAssetId() {
  return useAppStore.getState().preferences.map.terrainIonAssetId;
}

function saveIonAssetId(assetId: number) {
  const preferences = useAppStore.getState().preferences;
  useAppStore.getState().setPreferences({
    ...preferences,
    map: { ...preferences.map, terrainIonAssetId: assetId },
  });
}

describe("TerrainSettingsDialog Ion terrain", () => {
  beforeEach(() => {
    (window as unknown as RuntimeWindow).__GEOLIBRE_RUNTIME_ENV__ = { VITE_CESIUM_TOKEN: "tok" };
    useAppStore.setState({ primaryRenderer: "cesium" } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as RuntimeWindow).__GEOLIBRE_RUNTIME_ENV__;
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it("selects the Ion asset before dropping the COG source, then saves it", async () => {
    const { engine, calls } = fakeEngine({ cog: "https://example.com/dem.tif" });
    renderDialog(engine);
    fireEvent.change(screen.getByLabelText("Cesium Ion terrain asset"), {
      target: { value: "2767062" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Ion terrain" }));
    await waitFor(() => assert.equal(savedIonAssetId(), 2767062));
    assert.deepEqual(calls, ["ion:2767062", "cog:null"]);
  });

  it("keeps the COG source and reverts the asset when the Ion load fails", async () => {
    const { engine, calls } = fakeEngine({
      cog: "https://example.com/dem.tif",
      clearCog: false,
    });
    renderDialog(engine);
    fireEvent.change(screen.getByLabelText("Cesium Ion terrain asset"), {
      target: { value: "2767062" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Ion terrain" }));
    await screen.findByText("Could not apply the Cesium Ion terrain asset.");
    assert.deepEqual(calls, ["ion:2767062", "cog:null", "ion:null"]);
    assert.equal(engine.getTerrainCogSource(), "https://example.com/dem.tif");
    assert.equal(savedIonAssetId(), undefined);
  });

  it("keeps the saved Ion asset when a COG source fails to open", async () => {
    saveIonAssetId(2767062);
    const { engine, calls } = fakeEngine({ ion: 2767062 });
    renderDialog(engine);
    fireEvent.change(screen.getByLabelText("Terrain source"), {
      target: { value: "broken.tif" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use COG DEM" }));
    await screen.findByText(/Could not open the COG DEM/);
    assert.deepEqual(calls, ["cog:broken.tif"]);
    assert.equal(savedIonAssetId(), 2767062);
  });
});
