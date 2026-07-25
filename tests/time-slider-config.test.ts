import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  isTimeSliderIdle,
  maplibreTimeSliderPlugin,
} from "../packages/plugins/src/plugins/maplibre-time-slider";

// applyProjectState / getProjectState touch no app methods while no control is
// active (the plugin is never activated here), so a bare stub satisfies the type.
const app = {} as Parameters<NonNullable<typeof maplibreTimeSliderPlugin.applyProjectState>>[0];

const apply = (state: unknown): boolean =>
  maplibreTimeSliderPlugin.applyProjectState?.(app, state) ?? false;
const saved = (): Record<string, unknown> | undefined =>
  maplibreTimeSliderPlugin.getProjectState?.() as Record<string, unknown> | undefined;

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startDate: "2020-01-01T00:00:00.000Z",
    interval: 1,
    granularity: "year",
    currentDate: "2020-01-01T00:00:00.000Z",
    speed: 800,
    loop: true,
    sources: [],
    ...overrides,
  };
}

// Clear the plugin's persisted config between tests (no control is active, so a
// null state simply resets savedConfig to null).
afterEach(() => {
  apply(null);
});

describe("Time Slider open-ended end date persistence", () => {
  it("accepts a config with no endDate (open range) and saves it without one", () => {
    assert.equal(apply(baseConfig()), true);
    const config = saved();
    assert.ok(config);
    assert.equal("endDate" in config, false);
  });

  it("preserves an explicit endDate through a save round-trip", () => {
    assert.equal(apply(baseConfig({ endDate: "2024-12-31T00:00:00.000Z" })), true);
    assert.equal(saved()?.endDate, "2024-12-31T00:00:00.000Z");
  });

  it("treats an explicit null endDate as open and drops it on save", () => {
    assert.equal(apply(baseConfig({ endDate: null })), true);
    const config = saved();
    assert.ok(config);
    assert.equal("endDate" in config, false);
  });

  it("rejects a config whose endDate is present but not a string", () => {
    assert.equal(apply(baseConfig({ endDate: 42 })), false);
  });

  it("rejects a config missing a startDate", () => {
    const config = baseConfig();
    delete config.startDate;
    assert.equal(apply(config), false);
  });
});

describe("Time Slider mosaic source persistence", () => {
  const mosaicSource = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "mosaic",
    id: "s2-mosaic",
    name: "Sentinel-2 Monthly Mosaic",
    url: "https://data.source.coop/giswqs/opengeos/s2_mosaic_ts/s2_{date:YYYY}_{date:MM}.json",
    engine: "wasm",
    ...overrides,
  });

  it("round-trips a mosaic source (url + engine) through a save", () => {
    assert.equal(apply(baseConfig({ sources: [mosaicSource()] })), true);
    const config = saved();
    assert.ok(config);
    const sources = config.sources as Record<string, unknown>[];
    assert.equal(sources.length, 1);
    assert.equal(sources[0].type, "mosaic");
    assert.equal(sources[0].engine, "wasm");
    assert.equal(
      sources[0].url,
      "https://data.source.coop/giswqs/opengeos/s2_mosaic_ts/s2_{date:YYYY}_{date:MM}.json",
    );
  });

  it("rejects a mosaic source whose url is not a plain http(s) URL", () => {
    assert.equal(
      apply(baseConfig({ sources: [mosaicSource({ url: "javascript:alert(1)" })] })),
      false,
    );
  });
});

describe("isTimeSliderIdle", () => {
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

  afterEach(() => {
    withLayers([]);
  });

  it("is idle with no layers at all", () => {
    withLayers([]);
    assert.equal(isTimeSliderIdle(), true);
  });

  it("is idle when the remaining layers carry no time state", () => {
    withLayers([layer("a", {}), layer("b", { sourceKind: "maplibre-gl-vector" })]);
    assert.equal(isTimeSliderIdle(), true);
  });

  it("is busy while any layer is still bound", () => {
    withLayers([
      layer("a", {}),
      layer("b", { timeBinding: { property: "year", valueKind: "year" } }),
    ]);
    assert.equal(isTimeSliderIdle(), false);
  });

  it("ignores a malformed binding the Layers panel would not treat as bound", () => {
    // getLayerTimeBinding requires a string `property`, so this is not a
    // binding and must not keep the plugin switched on.
    withLayers([layer("a", { timeBinding: { valueKind: "year" } })]);
    assert.equal(isTimeSliderIdle(), true);
  });

  it("is busy while the dock owns a source of its own", () => {
    // Switching the plugin off would take the user's COG stack with it: the
    // dock is the only place those sources can be managed.
    withLayers([layer("cog", { sourceKind: "time-slider" })]);
    assert.equal(isTimeSliderIdle(), false);
  });

  it("is busy while a KML timespan overlay is present", () => {
    withLayers([layer("kml", { timeSpan: { begin: 1_600_000_000_000, end: null } })]);
    assert.equal(isTimeSliderIdle(), false);
  });

  it("treats a timespan without a numeric begin as inert", () => {
    withLayers([layer("kml", { timeSpan: { begin: null, end: null } })]);
    assert.equal(isTimeSliderIdle(), true);
  });
});
