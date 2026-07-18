import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreAppAPI, GeoLibreDeckGL } from "../packages/plugins/src/types";
import {
  ensureSharedDeckOverlay,
  onSharedDeckDevice,
  setSharedDeckLayers,
} from "../packages/plugins/src/plugins/shared-deck-overlay";

// A deck layer stand-in. Only identity/label matter for these assertions.
type FakeLayer = { id: string };
const layer = (id: string): FakeLayer => ({ id });
const ids = (layers: unknown): string[] => (layers as FakeLayer[]).map((l) => l.id);

// Captures the props handed to the single shared MapboxOverlay so a test can
// read back the aggregated layer list and drive the device callback.
class FakeMapboxOverlay {
  static instances: FakeMapboxOverlay[] = [];
  props: { layers?: FakeLayer[] } = {};
  onDeviceInitialized?: (device: unknown) => void;
  constructor(props: { layers?: FakeLayer[]; onDeviceInitialized?: (device: unknown) => void }) {
    this.onDeviceInitialized = props.onDeviceInitialized;
    FakeMapboxOverlay.instances.push(this);
  }
  setProps(props: { layers?: FakeLayer[] }): void {
    this.props = { ...this.props, ...props };
  }
  /** Latest aggregated layer ids pushed to this overlay. */
  layerIds(): string[] {
    return ids(this.props.layers ?? []);
  }
}

const fakeDeckGL = {
  mapbox: { MapboxOverlay: FakeMapboxOverlay },
} as unknown as GeoLibreDeckGL;

// A minimal host: records addMapControl/removeMapControl and hands back a stable
// (or swappable) map so the rebind path can be exercised.
function makeApp(map: object) {
  const state = {
    map,
    added: [] as unknown[],
    removed: [] as unknown[],
    addResult: true,
  };
  const app = {
    getDeckGL: () => Promise.resolve(fakeDeckGL),
    getMap: () => state.map,
    addMapControl: (control: unknown) => {
      if (!state.addResult) return false;
      state.added.push(control);
      return true;
    },
    removeMapControl: (control: unknown) => {
      state.removed.push(control);
    },
  } as unknown as GeoLibreAppAPI;
  return { app, state };
}

// The module is a per-map singleton, so tests share state. Each test clears the
// sources it touches at the end; the first test that binds a map does the mount.
const map1 = { id: "map1" };
const { app } = makeApp(map1);

describe("shared-deck-overlay", () => {
  it("mounts lazily and aggregates sources bottom-to-top (raster < google < deckviz)", async () => {
    FakeMapboxOverlay.instances.length = 0;
    await ensureSharedDeckOverlay(app);
    // No layers yet: the overlay exists but is not mounted (nothing to draw).
    const overlay = FakeMapboxOverlay.instances.at(-1);
    assert.ok(overlay, "overlay is created on ensure");
    assert.deepEqual(overlay?.layerIds(), []);

    // deckviz alone mounts and draws.
    setSharedDeckLayers("deckviz", [layer("d1")] as never);
    assert.deepEqual(overlay?.layerIds(), ["d1"]);

    // Adding raster and google interleaves them UNDER deckviz, in draw order.
    setSharedDeckLayers("raster", [layer("r1")] as never);
    setSharedDeckLayers("google-3d-tiles", [layer("g1")] as never);
    assert.deepEqual(
      overlay?.layerIds(),
      ["r1", "g1", "d1"],
      "raster drawn first (bottom), deckviz last (top)",
    );

    // Cleanup for the next test.
    setSharedDeckLayers("raster", [] as never);
    setSharedDeckLayers("google-3d-tiles", [] as never);
    setSharedDeckLayers("deckviz", [] as never);
    assert.deepEqual(overlay?.layerIds(), []);
  });

  it("keeps each source's own order and drops a source when set empty", () => {
    const overlay = FakeMapboxOverlay.instances.at(-1);
    setSharedDeckLayers("raster", [layer("r1"), layer("r2")] as never);
    assert.deepEqual(overlay?.layerIds(), ["r1", "r2"]);

    setSharedDeckLayers("deckviz", [layer("d1")] as never);
    assert.deepEqual(overlay?.layerIds(), ["r1", "r2", "d1"]);

    setSharedDeckLayers("raster", [] as never);
    assert.deepEqual(overlay?.layerIds(), ["d1"], "cleared raster is dropped");

    setSharedDeckLayers("deckviz", [] as never);
  });

  it("forwards the shared Deck device to registered listeners", () => {
    const overlay = FakeMapboxOverlay.instances.at(-1);
    const seen: unknown[] = [];
    const unsubscribe = onSharedDeckDevice((device) => seen.push(device));
    // Device is not ready yet, so nothing fires until the Deck initializes.
    assert.deepEqual(seen, []);

    const fakeDevice = { gl: true };
    overlay?.onDeviceInitialized?.(fakeDevice);
    assert.deepEqual(seen, [fakeDevice], "listener gets the device on init");

    // A listener registered after init is called immediately with the device.
    const late: unknown[] = [];
    const unsubscribeLate = onSharedDeckDevice((device) => late.push(device));
    assert.deepEqual(late, [fakeDevice]);

    unsubscribe();
    unsubscribeLate();
  });

  it("rebinds to a fresh overlay on a new map and re-applies live layers", async () => {
    setSharedDeckLayers("google-3d-tiles", [layer("g1")] as never);
    const before = FakeMapboxOverlay.instances.length;

    // A projection/globe toggle swaps the map: ensure() must build a new overlay
    // and replay the still-registered sources into it.
    const map2 = { id: "map2" };
    const { app: app2 } = makeApp(map2);
    await ensureSharedDeckOverlay(app2);

    assert.equal(
      FakeMapboxOverlay.instances.length,
      before + 1,
      "a fresh overlay is created for the new map",
    );
    const fresh = FakeMapboxOverlay.instances.at(-1);
    assert.deepEqual(
      fresh?.layerIds(),
      ["g1"],
      "the live google layer is replayed into the new overlay",
    );

    setSharedDeckLayers("google-3d-tiles", [] as never);
  });
});
