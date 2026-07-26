import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  configToOptions,
  createStoreLayer,
  isTimeSliderIdle,
  maplibreTimeSliderPlugin,
} from "../packages/plugins/src/plugins/maplibre-time-slider";
import type { SourceSpec } from "maplibre-gl-time-slider";

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

describe("Time Slider ordinal dates persistence", () => {
  const DATES = ["2023-01-28", "2023-02-20", "2023-03-27", "2025-10-03"];

  it("round-trips an explicit date list through a save", () => {
    assert.equal(apply(baseConfig({ dates: DATES })), true);
    assert.deepEqual(saved()?.dates, DATES);
  });

  it("round-trips the URL the dates were loaded from", () => {
    const datesUrl = "https://example.com/dates.json";
    assert.equal(apply(baseConfig({ dates: DATES, datesUrl })), true);
    assert.equal(saved()?.datesUrl, datesUrl);
  });

  it("omits dates for a continuous timeline", () => {
    assert.equal(apply(baseConfig()), true);
    const config = saved();
    assert.ok(config);
    assert.equal("dates" in config, false);
  });

  it("rejects a dates value that is not a list of strings", () => {
    assert.equal(apply(baseConfig({ dates: "2023-01-28" })), false);
    assert.equal(apply(baseConfig({ dates: [2023] })), false);
  });

  it("rejects a datesUrl that is not a plain http(s) URL", () => {
    assert.equal(apply(baseConfig({ dates: DATES, datesUrl: "javascript:alert(1)" })), false);
  });

  // The restore path builds a fresh control from options, so a `dates` list the
  // config carries but the options drop leaves the rebuilt timeline continuous.
  it("carries the date list into the options a rebuilt control is built from", () => {
    const options = configToOptions({
      startDate: "2023-01-01T00:00:00.000Z",
      interval: 1,
      granularity: "day",
      currentDate: "2023-01-28T00:00:00.000Z",
      speed: 800,
      loop: true,
      sources: [],
      dates: DATES,
    });
    assert.deepEqual(options.dates, DATES);
  });

  it("leaves the options without dates for a continuous timeline", () => {
    const options = configToOptions({
      startDate: "2023-01-01T00:00:00.000Z",
      interval: 1,
      granularity: "day",
      currentDate: "2023-01-28T00:00:00.000Z",
      speed: 800,
      loop: true,
      sources: [],
    });
    assert.equal(options.dates, undefined);
  });
});

describe("Time Slider store layer identify metadata", () => {
  it("marks a COG source for pixel identify", () => {
    const layer = createStoreLayer({
      type: "cog",
      id: "landsat",
      url: "https://example.com/{date:YYYY}.tif",
    } as SourceSpec);
    assert.equal(layer.type, "raster");
    assert.equal(layer.metadata.identifiable, true);
    assert.equal(layer.metadata.pixelIdentify, true);
  });

  it("marks a mosaic source for pixel identify", () => {
    const layer = createStoreLayer({
      type: "mosaic",
      id: "s2",
      url: "https://example.com/{date:YYYY}.json",
    } as SourceSpec);
    assert.equal(layer.metadata.identifiable, true);
    assert.equal(layer.metadata.pixelIdentify, true);
  });

  it("leaves pre-rendered tile sources unidentifiable", () => {
    // An XYZ/WMS source is a picture; there are no source values to report, so
    // the Identify icon stays disabled rather than opening an empty popup.
    for (const type of ["xyz", "wms"]) {
      const layer = createStoreLayer({
        type,
        id: `${type}-source`,
        tiles: "https://example.com/{z}/{x}/{y}.png",
        baseUrl: "https://example.com/wms",
      } as unknown as SourceSpec);
      assert.equal(layer.metadata.identifiable, false, type);
      assert.equal("pixelIdentify" in layer.metadata, false, type);
    }
  });

  it("marks a mosaic as client-rendered so the Style panel hides MapLibre-only paint", () => {
    // The flag rides on the layer rather than being read back from the control:
    // a restored project mirrors its layers before the plugin builds its
    // control, and asking the control during that window answers "no".
    const layer = createStoreLayer({
      type: "mosaic",
      id: "s2",
      url: "https://example.com/{date:YYYY}.json",
    } as SourceSpec);
    assert.equal(layer.metadata.clientRenderedRaster, true);
  });

  it("leaves a TiTiler COG unflagged, since MapLibre renders it natively", () => {
    const layer = createStoreLayer({
      type: "cog",
      id: "landsat",
      url: "https://example.com/{date:YYYY}.tif",
    } as SourceSpec);
    assert.equal("clientRenderedRaster" in layer.metadata, false);
  });

  it("carries a declared source extent so Zoom to layer has something to fit", () => {
    // A mirrored dock layer is external-native: there is no MapLibre source with
    // `bounds` to fall back on, so without this the button does nothing.
    const layer = createStoreLayer({
      type: "cog",
      id: "landsat",
      url: "https://example.com/{date:YYYY}.tif",
      bounds: [-10, -5, 10, 5],
    } as SourceSpec);
    assert.deepEqual(layer.metadata.bounds, [-10, -5, 10, 5]);
  });

  it("omits the extent when the source declares none", () => {
    const layer = createStoreLayer({
      type: "cog",
      id: "no-bounds",
      url: "https://example.com/{date:YYYY}.tif",
    } as SourceSpec);
    assert.equal("bounds" in layer.metadata, false);
  });

  it("ignores a malformed extent rather than passing it to the map", () => {
    const layer = createStoreLayer({
      type: "cog",
      id: "bad-bounds",
      url: "https://example.com/{date:YYYY}.tif",
      bounds: [-10, -5, Number.NaN, 5],
    } as unknown as SourceSpec);
    assert.equal("bounds" in layer.metadata, false);
  });

  it("leaves a GeoJSON source to the normal vector feature query", () => {
    const layer = createStoreLayer({
      type: "geojson",
      id: "quakes",
      data: "https://example.com/quakes.geojson",
      timeProperty: "time",
    } as SourceSpec);
    assert.equal(layer.type, "geojson");
    assert.equal("pixelIdentify" in layer.metadata, false);
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
