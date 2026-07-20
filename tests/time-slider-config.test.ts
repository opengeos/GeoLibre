import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { maplibreTimeSliderPlugin } from "../packages/plugins/src/plugins/maplibre-time-slider";

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

describe("Time Slider hosted descriptor", () => {
  it("keeps project state in the facade and uses only hosted MapEngine commands", () => {
    const invocations: Array<{ command: string; input: unknown }> = [];
    const runtimeState = baseConfig({
      endDate: "2024-12-31T00:00:00.000Z",
      sources: [
        {
          type: "cog",
          id: "landsat",
          url: "https://example.test/landsat_{date:YYYY}.tif",
        },
      ],
    });
    const hostedApp = {
      map: {
        invoke: (command: string, input: unknown) => {
          invocations.push({ command, input });
          if (command === "hosted-plugin.get-state") return runtimeState;
          return true;
        },
      },
    } as unknown as Parameters<NonNullable<typeof maplibreTimeSliderPlugin.activate>>[0];

    assert.equal(maplibreTimeSliderPlugin.activate(hostedApp), true);
    const activation = invocations[0].input as {
      onStateChange?: (state: unknown) => void;
    };
    activation.onStateChange?.(runtimeState);

    assert.deepEqual(saved(), runtimeState);
    assert.equal(maplibreTimeSliderPlugin.setMapControlPosition?.(hostedApp, "top-right"), true);
    assert.equal(maplibreTimeSliderPlugin.applyProjectState?.(hostedApp, runtimeState), true);
    maplibreTimeSliderPlugin.deactivate(hostedApp);

    assert.deepEqual(
      invocations.map(({ command }) => command),
      [
        "hosted-plugin.activate",
        "hosted-plugin.set-position",
        "hosted-plugin.apply-state",
        "hosted-plugin.get-state",
        "hosted-plugin.deactivate",
      ],
    );
    assert.deepEqual(saved(), runtimeState);
  });
});
