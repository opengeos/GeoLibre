import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CesiumBasemapImagery } from "../packages/core/src/cesium-imagery";
import {
  applyBasemapAppearance,
  applyBasemapImagery,
  getStadiaApiKey,
} from "../packages/map/src/cesium-basemap";

// Verifies that the project basemap lands at the bottom of the globe's imagery
// stack (below the data layers CesiumLayerSync appends), that a basemap change
// replaces only the basemap, and that the fallback honours the Ion token.
// Driven by a fake Cesium namespace + viewer — the real engine never loads
// here, since the module's Cesium import is type-only.

interface FakeLayer {
  provider?: Record<string, unknown>;
  source?: string;
}

function makeFakes() {
  // The imagery stack, bottom (index 0) to top, as Cesium models it.
  const stack: FakeLayer[] = [];
  const arcgisRequests: Array<{ url: string; options: unknown }> = [];

  const viewer = {
    imageryLayers: {
      addImageryProvider(provider: unknown, index?: number) {
        const layer: FakeLayer = { provider: provider as Record<string, unknown> };
        stack.splice(index ?? stack.length, 0, layer);
        return layer;
      },
      add(layer: FakeLayer, index?: number) {
        stack.splice(index ?? stack.length, 0, layer);
      },
      remove(layer: FakeLayer) {
        const i = stack.indexOf(layer);
        if (i >= 0) stack.splice(i, 1);
        return i >= 0;
      },
    },
  };

  const Cesium = {
    ArcGisMapServerImageryProvider: {
      fromUrl(url: string, options: unknown) {
        arcgisRequests.push({ url, options });
        return Promise.resolve({});
      },
    },
    UrlTemplateImageryProvider: class {
      url: string;
      maximumLevel?: number;
      credit?: string;
      constructor(options: { url: string; maximumLevel?: number; credit?: string }) {
        this.url = options.url;
        this.maximumLevel = options.maximumLevel;
        this.credit = options.credit;
      }
    },
    OpenStreetMapImageryProvider: class {
      url: string;
      constructor(options: { url: string }) {
        this.url = options.url;
      }
    },
    ImageryLayer: {
      fromWorldImagery: (): FakeLayer => ({ source: "ion-world-imagery" }),
      fromProviderAsync: (): FakeLayer => ({ source: "osm" }),
    },
  };

  // The two fakes only implement the surface applyBasemapImagery touches.
  return {
    stack,
    arcgisRequests,
    viewer: viewer as unknown as Parameters<typeof applyBasemapImagery>[1],
    Cesium: Cesium as unknown as Parameters<typeof applyBasemapImagery>[0],
  };
}

/** A data layer of the kind CesiumLayerSync appends above the basemap. */
function pushDataLayer(stack: FakeLayer[]): FakeLayer {
  const layer: FakeLayer = { source: "data-layer" };
  stack.push(layer);
  return layer;
}

const XYZ: CesiumBasemapImagery = {
  kind: "xyz",
  template: "https://tiles.example.com/{z}/{x}/{y}.png",
  attribution: "© Example",
  maximumLevel: 20,
};

describe("applyBasemapImagery", () => {
  it("puts the basemap below the data layers", () => {
    const { Cesium, viewer, stack } = makeFakes();
    const data = pushDataLayer(stack);

    const added = applyBasemapImagery(Cesium, viewer, [], XYZ, undefined);

    assert.equal(stack.length, 2);
    assert.equal(stack[0], added[0], "basemap should sit at the bottom");
    assert.equal(stack[1], data, "the data layer should stay above it");
  });

  it("replaces only the basemap when it changes, leaving data layers in place", () => {
    const { Cesium, viewer, stack } = makeFakes();
    const first = applyBasemapImagery(Cesium, viewer, [], XYZ, undefined);
    const data = pushDataLayer(stack);

    const next: CesiumBasemapImagery = {
      ...XYZ,
      template: "https://other.example/{z}/{x}/{y}.png",
    };
    const second = applyBasemapImagery(Cesium, viewer, first, next, undefined);

    assert.equal(stack.length, 2);
    assert.equal(stack[0], second[0]);
    assert.equal(stack[1], data);
    assert.ok(!stack.includes(first[0]), "the previous basemap should be gone");
    assert.equal(
      (second[0] as FakeLayer).provider?.url,
      "https://other.example/{z}/{x}/{y}.png",
      "the new template should be in use",
    );
  });

  it("stacks a hybrid basemap's overlay directly above its imagery", () => {
    const { Cesium, viewer, stack } = makeFakes();
    const data = pushDataLayer(stack);

    const added = applyBasemapImagery(
      Cesium,
      viewer,
      [],
      { ...XYZ, overlayTemplate: "https://tiles.example.com/labels/{z}/{x}/{y}.png" },
      undefined,
    );

    assert.equal(added.length, 2);
    assert.deepEqual(stack, [added[0], added[1], data]);
    assert.equal(
      (added[1] as FakeLayer).provider?.url,
      "https://tiles.example.com/labels/{z}/{x}/{y}.png",
    );
  });

  it("swaps {y} for {reverseY} on a TMS source, and leaves XYZ alone", () => {
    const { Cesium, viewer } = makeFakes();
    const tms = applyBasemapImagery(Cesium, viewer, [], { ...XYZ, scheme: "tms" }, undefined);
    assert.equal(
      (tms[0] as FakeLayer).provider?.url,
      "https://tiles.example.com/{z}/{x}/{reverseY}.png",
    );

    const xyz = applyBasemapImagery(Cesium, viewer, tms, XYZ, undefined);
    assert.equal((xyz[0] as FakeLayer).provider?.url, XYZ.kind === "xyz" ? XYZ.template : "");
  });

  it("passes the attribution through as the provider credit", () => {
    const { Cesium, viewer } = makeFakes();
    const added = applyBasemapImagery(Cesium, viewer, [], XYZ, undefined);
    assert.equal((added[0] as FakeLayer).provider?.credit, "© Example");
    assert.equal((added[0] as FakeLayer).provider?.maximumLevel, 20);
  });

  it("draws nothing for the blank basemap", () => {
    const { Cesium, viewer, stack } = makeFakes();
    const first = applyBasemapImagery(Cesium, viewer, [], XYZ, undefined);
    const data = pushDataLayer(stack);

    const added = applyBasemapImagery(Cesium, viewer, first, { kind: "none" }, undefined);

    assert.deepEqual(added, []);
    assert.deepEqual(stack, [data], "only the data layer should remain");
  });

  it("switches to Esri without removing raster overlays or using Cesium's demo token", () => {
    const { Cesium, viewer, stack, arcgisRequests } = makeFakes();
    const previous = applyBasemapImagery(Cesium, viewer, [], XYZ, undefined);
    const data = pushDataLayer(stack);
    const url = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
    const added = applyBasemapImagery(Cesium, viewer, previous, { kind: "arcgis", url }, undefined);
    assert.deepEqual(arcgisRequests, [{ url, options: { enablePickFeatures: false } }]);
    assert.deepEqual(stack, [added[0], data]);
  });

  it("adds the live Stadia key only to Stadia requests, encoding special characters", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __GEOLIBRE_RUNTIME_ENV__: { VITE_STADIA_API_KEY: " test&key=? " } },
    });
    try {
      const { Cesium, viewer } = makeFakes();
      const template = "https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg";
      const added = applyBasemapImagery(
        Cesium,
        viewer,
        [],
        { ...XYZ, template, apiKeyProvider: "stadia" },
        undefined,
      );
      assert.equal((added[0] as FakeLayer).provider?.url, template + "?api_key=test%26key%3D%3F");
      const unrelated = applyBasemapImagery(Cesium, viewer, added, XYZ, undefined);
      assert.equal(
        (unrelated[0] as FakeLayer).provider?.url,
        XYZ.kind === "xyz" ? XYZ.template : "",
      );
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("allows Stadia domain authentication and normalizes runtime API keys", () => {
    assert.equal(getStadiaApiKey({}), undefined);
    assert.equal(
      getStadiaApiKey({ VITE_STADIA_API_KEY: " first ", STADIA_API_KEY: "second" }),
      "first",
    );
    assert.equal(getStadiaApiKey({ STADIA_API_KEY: " second " }), "second");
  });

  it("falls back to Ion World Imagery when a token is configured", () => {
    const { Cesium, viewer, stack } = makeFakes();
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "default" }, "ion.jwt.token");
    assert.equal((added[0] as FakeLayer).source, "ion-world-imagery");
    assert.equal(stack[0], added[0]);
  });

  it("falls back to keyless OpenStreetMap without a token", () => {
    const { Cesium, viewer } = makeFakes();
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "default" }, undefined);
    assert.equal((added[0] as FakeLayer).source, "osm");
  });
});

describe("applyBasemapAppearance", () => {
  it("applies the project's basemap visibility and opacity", () => {
    const { Cesium, viewer } = makeFakes();
    const added = applyBasemapImagery(Cesium, viewer, [], XYZ, undefined);

    applyBasemapAppearance(added, false, 0.4);

    assert.equal((added[0] as { show?: boolean }).show, false);
    assert.equal((added[0] as { alpha?: number }).alpha, 0.4);
  });

  it("fades a hybrid basemap's overlay with its imagery", () => {
    // The 2D map treats the imagery and its labels overlay as one background,
    // so both follow the single Background row in the layer panel.
    const { Cesium, viewer } = makeFakes();
    const added = applyBasemapImagery(
      Cesium,
      viewer,
      [],
      { ...XYZ, overlayTemplate: "https://tiles.example.com/labels/{z}/{x}/{y}.png" },
      undefined,
    );

    applyBasemapAppearance(added, true, 0.25);

    assert.equal(added.length, 2);
    for (const layer of added) {
      assert.equal((layer as { show?: boolean }).show, true);
      assert.equal((layer as { alpha?: number }).alpha, 0.25);
    }
  });
});
