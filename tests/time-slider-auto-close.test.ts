import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { isTimeSliderIdle } from "../packages/plugins/src/plugins/maplibre-time-slider";
import {
  __resetTimeSliderDockForTests,
  isTimeSliderOpenedByBinding,
  setTimeSliderOpenedByBinding,
  shouldCloseTimeSliderDock as shouldClose,
} from "../apps/geolibre-desktop/src/lib/time-slider-dock";

// The app passes the real `isTimeSliderIdle`, so these exercise the whole
// predicate rather than a stand-in for the "nothing left to drive" half.
const shouldCloseTimeSliderDock = (active: boolean): boolean =>
  shouldClose(active, isTimeSliderIdle);

// The dock closes itself once the last temporal binding is gone (#1512), but
// only when a binding is what opened it. These assert the policy that decides
// that; `isTimeSliderIdle` (tested in time-slider-config.test.ts) supplies the
// "nothing left to drive" half.

const layer = (id: string, metadata: Record<string, unknown>): GeoLibreLayer => ({
  id,
  name: id,
  type: "geojson",
  source: { type: "geojson" },
  visible: true,
  opacity: 1,
  style: { ...DEFAULT_LAYER_STYLE },
  metadata,
});

const withLayers = (layers: GeoLibreLayer[]): void => {
  useAppStore.setState({ layers });
};

const boundLayer = layer("points", {
  timeBinding: { property: "date", valueKind: "iso" },
});

describe("time slider auto-close", () => {
  afterEach(() => {
    withLayers([]);
    __resetTimeSliderDockForTests();
  });

  it("closes a binding-opened dock once the bound layer is gone", () => {
    setTimeSliderOpenedByBinding(true);
    withLayers([boundLayer]);
    assert.equal(shouldCloseTimeSliderDock(true), false);

    // The layer is removed rather than unbound, which is the route the Layers
    // panel's Unbind action never sees.
    withLayers([]);
    assert.equal(shouldCloseTimeSliderDock(true), true);
  });

  it("leaves a dock the user opened alone, even with nothing to drive", () => {
    withLayers([]);
    assert.equal(isTimeSliderOpenedByBinding(), false);
    assert.equal(shouldCloseTimeSliderDock(true), false);
  });

  it("leaves a user-opened dock alone after a bind/remove round trip", () => {
    // Binding a layer into an already-open dock must not adopt it: the user
    // opened it, so it is theirs to close.
    withLayers([boundLayer]);
    withLayers([]);
    assert.equal(shouldCloseTimeSliderDock(true), false);
  });

  it("keeps a binding-opened dock while another binding remains", () => {
    setTimeSliderOpenedByBinding(true);
    withLayers([
      layer("cube", {
        timeBinding: {
          kind: "selector",
          dimension: "time",
          min: Date.UTC(2020, 0, 1),
          max: Date.UTC(2020, 0, 31),
          granularity: "day",
        },
      }),
    ]);
    assert.equal(shouldCloseTimeSliderDock(true), false);
  });

  it("keeps a binding-opened dock while it owns raster sources of its own", () => {
    // Closing it would take the user's COG stack with it: the dock is the only
    // place those sources can be managed.
    setTimeSliderOpenedByBinding(true);
    withLayers([layer("cog", { sourceKind: "time-slider" })]);
    assert.equal(shouldCloseTimeSliderDock(true), false);
  });

  it("does nothing when the plugin is already inactive", () => {
    setTimeSliderOpenedByBinding(true);
    withLayers([]);
    assert.equal(shouldCloseTimeSliderDock(false), false);
  });

  it("forgets the binding origin once the dock is closed", () => {
    // usePlugins clears the flag on every deactivation, so a later manual
    // activation starts from a clean slate.
    setTimeSliderOpenedByBinding(true);
    setTimeSliderOpenedByBinding(false);
    withLayers([]);
    assert.equal(shouldCloseTimeSliderDock(true), false);
  });
});
