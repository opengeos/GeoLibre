import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CesiumBasemapImagery } from "../packages/core/src/cesium-imagery";
import { applyBasemapAppearance, applyBasemapImagery } from "../packages/map/src/cesium-basemap";

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
  const ionRequests: Array<{ assetId: number; options: unknown }> = [];
  const openStreetMapRequests: Array<{ url: string }> = [];

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
        openStreetMapRequests.push({ url: options.url });
      }
    },
    IonImageryProvider: {
      fromAssetId(assetId: number, options: unknown) {
        ionRequests.push({ assetId, options });
        return Promise.resolve({});
      },
    },
    ImageryLayer: {
      fromProviderAsync: (provider: unknown): FakeLayer => ({ provider: { provider } }),
    },
  };

  // The two fakes only implement the surface applyBasemapImagery touches.
  return {
    stack,
    arcgisRequests,
    ionRequests,
    openStreetMapRequests,
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

  it("uses Bing Maps Aerial through Ion when a token is configured", () => {
    const { Cesium, viewer, stack, ionRequests } = makeFakes();
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "default" }, "ion.jwt.token");
    assert.deepEqual(ionRequests, [{ assetId: 2, options: { accessToken: "ion.jwt.token" } }]);
    assert.equal(stack[0], added[0]);
  });

  it("falls back to keyless Esri World Imagery without a token", async () => {
    const { Cesium, viewer, ionRequests, arcgisRequests, openStreetMapRequests } = makeFakes();
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "default" }, undefined);
    assert.ok((added[0] as FakeLayer).provider?.provider instanceof Promise);
    // Which provider, not merely that one was promised: an Ion basemap would
    // satisfy the shape above while needing the key this branch exists to do
    // without, and street tiles under a globe mostly show empty ocean.
    assert.deepEqual(
      arcgisRequests.map(({ url }) => url),
      ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"],
    );
    assert.deepEqual(ionRequests, []);
    await (added[0] as FakeLayer).provider?.provider;
    assert.deepEqual(openStreetMapRequests, [], "Esri answered, so nothing stood in for it");
  });

  it("falls through to keyless imagery when an Ion token is refused", async () => {
    const { Cesium, viewer, arcgisRequests } = makeFakes();
    Cesium.IonImageryProvider.fromAssetId = () => Promise.reject(new Error("401 token revoked"));
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "default" }, "stale.jwt.token");
    await (added[0] as FakeLayer).provider?.provider;
    // A revoked or expired token leaves a drawn globe, not a bare one.
    assert.deepEqual(
      arcgisRequests.map(({ url }) => url),
      ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"],
    );
  });

  it("keeps a refused Ion basemap from blanking the globe", async () => {
    // The chosen basemap is an Ion asset, not the `default` fallback: a token
    // restricted to other origins 403s here, and Cesium draws no tile at all
    // while any imagery layer in the stack has no provider — the globe goes to
    // bare space rather than merely losing its basemap.
    const { Cesium, viewer, arcgisRequests } = makeFakes();
    Cesium.IonImageryProvider.fromAssetId = () => Promise.reject(new Error("403 Forbidden"));
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "ion", assetId: 2 }, "jwt.token");
    const provider = await (added[0] as FakeLayer).provider?.provider;
    assert.ok(provider, "the layer resolved to a provider instead of rejecting");
    assert.deepEqual(
      arcgisRequests.map(({ url }) => url),
      ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"],
    );
  });

  it("keeps an unreachable ArcGIS basemap from blanking the globe", async () => {
    const { Cesium, viewer, openStreetMapRequests } = makeFakes();
    const attempted: string[] = [];
    Cesium.ArcGisMapServerImageryProvider.fromUrl = (url: string) => {
      attempted.push(url);
      return Promise.reject(new Error("offline"));
    };
    const url = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "arcgis", url }, undefined);
    const provider = await (added[0] as FakeLayer).provider?.provider;
    assert.ok(provider, "the layer resolved to a provider instead of rejecting");
    // World Imagery is itself the keyless fallback, so it is tried once, not
    // twice: a retry would double the wait before the globe draws anything.
    assert.deepEqual(attempted, [url]);
    assert.deepEqual(openStreetMapRequests, [{ url: "https://tile.openstreetmap.org/" }]);
  });

  it("stands OpenStreetMap in when the keyless imagery service cannot be reached", async () => {
    const { Cesium, viewer, openStreetMapRequests } = makeFakes();
    Cesium.ArcGisMapServerImageryProvider.fromUrl = () => Promise.reject(new Error("offline"));
    const added = applyBasemapImagery(Cesium, viewer, [], { kind: "default" }, undefined);
    await (added[0] as FakeLayer).provider?.provider;
    assert.deepEqual(openStreetMapRequests, [{ url: "https://tile.openstreetmap.org/" }]);
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
