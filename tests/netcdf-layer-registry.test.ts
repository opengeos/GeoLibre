import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getNetcdfImageSource,
  getNetcdfLayerState,
  registerNetcdfLayer,
  releaseNetcdfLayer,
} from "../apps/geolibre-desktop/src/lib/netcdf-layer-registry";
import type { LocalNetcdfGrid } from "../packages/plugins/src/plugins/local-netcdf";

/** A 2x2 slice whose values tag their cell, so a mix-up between two is visible. */
function grid(first: number): LocalNetcdfGrid {
  return {
    ny: 2,
    nx: 2,
    values: new Float32Array([first, first + 1, first + 2, first + 3]),
    lat: new Float64Array([20, 10]),
    lon: new Float64Array([0, 1]),
    fillValue: null,
    dataClim: [first, first + 3],
  };
}

const registered: string[] = [];

/** Register a layer and remember it, so a failing assertion cannot leak state. */
function register(id: string, state: Parameters<typeof registerNetcdfLayer>[1]): void {
  registered.push(id);
  registerNetcdfLayer(id, state);
}

afterEach(() => {
  for (const id of registered.splice(0)) releaseNetcdfLayer(id);
});

describe("netcdf layer registry", () => {
  it("offers a single-band layer's slice for re-colormapping", () => {
    register("single", { grid: grid(1), variable: "reflectance" });
    assert.equal(getNetcdfImageSource("single")?.dataClim[0], 1);
    assert.equal(getNetcdfLayerState("single")?.variable, "reflectance");
  });

  it("retains an RGB composite but offers it no colormap to re-apply", () => {
    // The pixels came from three channels, each stretched to its own range;
    // re-baking any one of them with a colormap would replace the composite
    // with a single-band image, so the symbology controls must stay away.
    const channels: [LocalNetcdfGrid, LocalNetcdfGrid, LocalNetcdfGrid] = [
      grid(1),
      grid(10),
      grid(100),
    ];
    register("rgb", {
      grid: channels[0],
      variable: "reflectance",
      rgb: { bands: [40, 25, 10], channels },
    });

    // Null here is what keeps the Style panel's colormap section closed...
    assert.equal(getNetcdfImageSource("rgb"), null);
    // ...while the state itself is what Identify and the spectral profile ask
    // for, so a composite is still clickable.
    const state = getNetcdfLayerState("rgb");
    assert.equal(state?.rgb?.bands[0], 40);
    assert.equal(state?.rgb?.channels[1].values[0], 10);
    // The red channel doubles as the grid, so the cell lookup and the cube
    // window read the geometry all three share.
    assert.equal(state?.grid, channels[0]);
  });

  it("forgets everything about a released layer", () => {
    register("gone", { grid: grid(1), variable: "reflectance" });
    releaseNetcdfLayer("gone");
    assert.equal(getNetcdfLayerState("gone"), null);
    assert.equal(getNetcdfImageSource("gone"), null);
  });

  it("closes the previous cube when a second one registers, keeping its channels", () => {
    let closed = 0;
    const cube = {
      axis: { name: "bands", size: 3 },
      readProfile: async () => ({ axis: "bands", values: [] }) as never,
      readBand: async () => grid(1),
      close: () => {
        closed += 1;
      },
    };
    const channels: [LocalNetcdfGrid, LocalNetcdfGrid, LocalNetcdfGrid] = [
      grid(1),
      grid(10),
      grid(100),
    ];
    register("first", {
      grid: channels[0],
      variable: "reflectance",
      cube,
      rgb: { bands: [0, 1, 2], channels },
    });
    register("second", { grid: grid(1), variable: "other", cube: { ...cube, close: () => {} } });

    assert.equal(closed, 1);
    // Only the file goes: the retained channels are what the popup reads, and
    // dropping them would leave the older composite silently unclickable.
    const first = getNetcdfLayerState("first");
    assert.equal(first?.cube, undefined);
    assert.equal(first?.rgb?.channels.length, 3);
  });
});
