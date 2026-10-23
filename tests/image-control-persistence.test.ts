import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { maplibreComponentsPlugin } from "../packages/plugins/src/plugins/maplibre-components";
import {
  closeImagePanel,
  getImageControlStates,
  setImageControl,
} from "../packages/plugins/src/plugins/components/image";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// A stand-in for the app API: controls are only tracked, never drawn, so the
// save/restore logic is exercised without a map.
function fakeApp() {
  const mounted: unknown[] = [];
  const app = {
    addMapControl: (control: unknown) => {
      mounted.push(control);
      return true;
    },
    removeMapControl: (control: unknown) => {
      const index = mounted.indexOf(control);
      if (index >= 0) mounted.splice(index, 1);
    },
  } as unknown as GeoLibreAppAPI;
  return { app, mounted };
}

describe("Image control project persistence", () => {
  const { app, mounted } = fakeApp();
  afterEach(() => closeImagePanel(app));

  it("saves every image in the Components plugin state and restores them", () => {
    setImageControl(app, {
      id: "logo",
      title: "Logo",
      url: "https://x.example/logo.png",
      sizeMode: "ratio",
      width: 300,
      ratio: 2,
      position: "top-right",
    });
    setImageControl(app, {
      id: "arrow",
      title: "North arrow",
      url: "https://x.example/arrow.png",
      sizeMode: "fixed",
      width: 80,
      height: 90,
      collapsed: true,
    });
    const saved = JSON.parse(JSON.stringify(maplibreComponentsPlugin.getProjectState?.()));
    assert.equal(saved.images.length, 2);

    closeImagePanel(app);
    assert.equal(getImageControlStates().length, 0);
    assert.equal(mounted.length, 0);
    assert.equal(maplibreComponentsPlugin.getProjectState?.(), undefined);

    maplibreComponentsPlugin.applyProjectState?.(app, saved);
    assert.deepEqual(getImageControlStates(), saved.images);
    assert.equal(mounted.length, 2);
    // Saving again after a restore gives the same state back.
    assert.deepEqual(
      JSON.parse(JSON.stringify(maplibreComponentsPlugin.getProjectState?.())),
      saved,
    );
  });

  it("clears the images when a project without any is loaded", () => {
    setImageControl(app, { id: "a", url: "https://x.example/a.png" });
    maplibreComponentsPlugin.applyProjectState?.(app, {});
    assert.equal(getImageControlStates().length, 0);
    assert.equal(mounted.length, 0);
  });

  it("ignores a saved image whose URL is not https", () => {
    maplibreComponentsPlugin.applyProjectState?.(app, {
      images: [
        { id: "ok", url: "https://x.example/a.png" },
        { id: "bad", url: "javascript:alert(1)" },
        { id: "http", url: "http://x.example/a.png" },
      ],
    });
    assert.deepEqual(
      getImageControlStates().map((image) => image.id),
      ["ok"],
    );
  });
});
