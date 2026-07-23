import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_LEGEND_CONFIG,
  type GeoLibreLayer,
  type LegendConfig,
} from "../packages/core/src/index";
import {
  buildAutoLegend,
  formatLegendNumber,
  legendRowKey,
  newCustomSectionId,
  removeLegendCustomEntry,
  setLegendCustomEntry,
} from "../apps/geolibre-desktop/src/lib/auto-legend";

function layer(over: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "l",
    name: "Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...over,
  } as GeoLibreLayer;
}

function config(over: Partial<LegendConfig> = {}): LegendConfig {
  return { ...DEFAULT_LEGEND_CONFIG, ...over };
}

const EN = { locale: "en" };

describe("formatLegendNumber", () => {
  it("abbreviates large values but keeps 4-digit values (years) exact", () => {
    assert.equal(formatLegendNumber(8918925.75, "en"), "8.9M");
    assert.equal(formatLegendNumber(25000, "en"), "25.0K");
    assert.equal(formatLegendNumber(1995, "en"), "1,995");
    assert.equal(formatLegendNumber(3.14159, "en"), "3.14");
  });
});

describe("buildAutoLegend — vector layers", () => {
  it("lists visible layers top-first and skips hidden ones", () => {
    const entries = buildAutoLegend(
      [
        layer({ id: "a", name: "A", metadata: { geometryType: "point" } }),
        layer({ id: "b", name: "B", visible: false }),
        layer({ id: "c", name: "C", metadata: { geometryType: "line" } }),
      ],
      config(),
      EN,
    );
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["C", "A"],
    );
    assert.equal(entries[0].shape, "line");
    assert.equal(entries[1].shape, "circle");
  });

  it("renders a graduated layer as range-labelled class rows with a field caption", () => {
    const entries = buildAutoLegend(
      [
        layer({
          id: "g",
          metadata: { geometryType: "polygon" },
          style: {
            ...DEFAULT_LAYER_STYLE,
            vectorStyleMode: "graduated",
            vectorStyleProperty: "population",
            vectorStyleStops: [
              { value: 0, color: "#111111" },
              { value: 25000, color: "#222222" },
              { value: 8918925, color: "#333333" },
            ],
          },
        }),
      ],
      config(),
      EN,
    );
    const [entry] = entries;
    assert.equal(entry.fieldLabel, "population");
    assert.equal(entry.headerSwatch, null);
    assert.deepEqual(
      entry.rows.map((row) => row.label),
      ["0 – 25.0K", "25.0K – 8.9M", "≥ 8.9M"],
    );
    assert.equal(entry.rows[1].color, "#222222");
    assert.equal(entry.rows[1].shape, "square");
  });

  it("renders a categorized layer with value (or stop label) rows", () => {
    const entries = buildAutoLegend(
      [
        layer({
          id: "cat",
          name: "Era",
          metadata: { geometryType: "polygon" },
          style: {
            ...DEFAULT_LAYER_STYLE,
            vectorStyleMode: "categorized",
            vectorStyleStops: [
              { value: "old", color: "#8c2d04", label: "Historic" },
              { value: "new", color: "#08306b" },
            ],
          },
        }),
      ],
      config(),
      EN,
    );
    assert.deepEqual(
      entries[0].rows.map((row) => [row.label, row.color]),
      [
        ["Historic", "#8c2d04"],
        ["new", "#08306b"],
      ],
    );
  });

  it("gives a single-symbol point layer a marker-aware header swatch", () => {
    const entries = buildAutoLegend(
      [
        layer({
          id: "pt",
          metadata: { geometryType: "point" },
          style: {
            ...DEFAULT_LAYER_STYLE,
            markerEnabled: true,
            markerShape: "star",
            markerColor: "#ff0000",
          },
        }),
      ],
      config(),
      EN,
    );
    assert.equal(entries[0].headerSwatch?.marker?.shape, "star");
    assert.equal(entries[0].headerSwatch?.color, "#ff0000");
    assert.equal(entries[0].rows.length, 0);
  });

  it("renders a heatmap point layer as a gradient with generic end labels", () => {
    const entries = buildAutoLegend(
      [
        layer({
          id: "heat",
          metadata: { geometryType: "point" },
          style: { ...DEFAULT_LAYER_STYLE, pointRenderer: "heatmap" },
        }),
      ],
      config(),
      EN,
    );
    const [entry] = entries;
    assert.ok(entry.gradient);
    assert.equal(entry.gradient?.minLabel, null);
    assert.equal(entry.gradient?.maxLabel, null);
    assert.ok((entry.gradient?.colors.length ?? 0) >= 2);
  });

  it("adds proportional-symbol size rows for a point layer", () => {
    const entries = buildAutoLegend(
      [
        layer({
          id: "prop",
          metadata: { geometryType: "point" },
          style: {
            ...DEFAULT_LAYER_STYLE,
            proportionalSizeEnabled: true,
            proportionalSizeProperty: "magnitude",
            proportionalSizeMinValue: 0,
            proportionalSizeMaxValue: 100,
            proportionalSizeMinRadius: 4,
            proportionalSizeMaxRadius: 12,
          },
        }),
      ],
      config(),
      EN,
    );
    const [entry] = entries;
    assert.equal(entry.fieldLabel, "magnitude");
    assert.deepEqual(
      entry.rows.map((row) => [row.label, row.size]),
      [
        ["0", 4],
        ["50", 8],
        ["100", 12],
      ],
    );
    assert.ok(entry.rows.every((row) => row.shape === "circle"));
  });
});

describe("buildAutoLegend — raster layers", () => {
  const rasterBase = {
    type: "cog" as const,
    source: { type: "raster" as const },
  };

  it("renders a continuous colormap as a gradient labelled with the rescale range", () => {
    const entries = buildAutoLegend(
      [
        layer({
          ...rasterBase,
          id: "dem",
          metadata: {
            rasterState: { mode: "single", colormap: "viridis", rescale: [[0, 3000]] },
          },
        }),
      ],
      config(),
      { ...EN, resolveColormapColors: () => ["#000000", "#ffffff"] },
    );
    const [entry] = entries;
    assert.ok(entry.gradient);
    assert.equal(entry.gradient?.minLabel, "0");
    assert.equal(entry.gradient?.maxLabel, "3,000");
    assert.equal(entry.gradient?.colors[0], "#000000");
  });

  it("reverses the gradient when rasterState.reversed is set", () => {
    const entries = buildAutoLegend(
      [
        layer({
          ...rasterBase,
          id: "dem",
          metadata: {
            rasterState: { mode: "single", colormap: "viridis", reversed: true },
          },
        }),
      ],
      config(),
      { ...EN, resolveColormapColors: () => ["#000000", "#ffffff"] },
    );
    assert.equal(entries[0].gradient?.colors[0], "#ffffff");
    // No rescale → generic Low/High labels are the panel's job.
    assert.equal(entries[0].gradient?.minLabel, null);
  });

  it("renders a classified raster as closed-range class rows", () => {
    const entries = buildAutoLegend(
      [
        layer({
          ...rasterBase,
          id: "class",
          metadata: {
            rasterState: { mode: "single", colormap: "viridis" },
            rasterSymbology: {
              classified: true,
              ramp: "viridis",
              method: "equal-interval",
              classCount: 3,
              breaks: [0, 10, 20, 30],
            },
          },
        }),
      ],
      config(),
      { ...EN, resolveColormapColors: () => ["#000000", "#888888", "#ffffff"] },
    );
    const [entry] = entries;
    assert.equal(entry.gradient, null);
    assert.deepEqual(
      entry.rows.map((row) => row.label),
      ["0 – 10", "10 – 20", "20 – 30"],
    );
  });

  it("labels classified classes from a matching Raster Attribute Table (NLCD names)", () => {
    const entries = buildAutoLegend(
      [
        layer({
          ...rasterBase,
          id: "nlcd",
          metadata: {
            rasterState: { mode: "single", colormap: "palette" },
            rasterSymbology: {
              classified: true,
              ramp: "viridis",
              method: "manual",
              classCount: 2,
              breaks: [11, 21, 31],
            },
            rasterAttributeTable: {
              band: 1,
              rows: [
                { value: 11, count: 10, label: "Open Water", color: "#466b9f" },
                { value: 21, count: 20, label: "Developed", color: "#dec5c5" },
              ],
              pixelAreaM2: null,
            },
          },
        }),
      ],
      config(),
      EN,
    );
    assert.deepEqual(
      entries[0].rows.map((row) => [row.label, row.color]),
      [
        ["Open Water", "#466b9f"],
        ["Developed", "#dec5c5"],
      ],
    );
  });

  it("gives a palette raster (no classification) a heading-only entry", () => {
    const entries = buildAutoLegend(
      [
        layer({
          ...rasterBase,
          id: "pal",
          metadata: { rasterState: { mode: "single", colormap: "palette" } },
        }),
      ],
      config(),
      EN,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].rows.length, 0);
    assert.equal(entries[0].gradient, null);
    assert.equal(entries[0].shape, "raster");
  });
});

describe("buildAutoLegend — custom entries and overrides", () => {
  it("replaces a layer's derived rows with its hand-authored custom entry", () => {
    const base = config();
    const custom = setLegendCustomEntry(base, "pal", {
      title: "Land Cover",
      items: [
        { label: "Open Water", color: "#466b9f" },
        { label: "Forest", color: "#1c6330", shape: "circle" },
      ],
    });
    const entries = buildAutoLegend(
      [
        layer({
          id: "pal",
          type: "cog",
          source: { type: "raster" },
          metadata: { rasterState: { mode: "single", colormap: "palette" } },
        }),
      ],
      custom,
      EN,
    );
    const [entry] = entries;
    assert.equal(entry.name, "Land Cover");
    assert.equal(entry.custom, true);
    assert.equal(entry.standalone, false);
    assert.deepEqual(
      entry.rows.map((row) => [row.label, row.shape]),
      [
        ["Open Water", "square"],
        ["Forest", "circle"],
      ],
    );
  });

  it("renders standalone custom sections and honors the order list", () => {
    let cfg = config();
    const id = newCustomSectionId(cfg);
    assert.equal(id, "custom:1");
    cfg = setLegendCustomEntry(cfg, id, {
      title: "Notes",
      items: [{ label: "Study area", color: "#000000" }],
    });
    cfg = { ...cfg, order: [id, "a"] };
    const entries = buildAutoLegend([layer({ id: "a", name: "A" })], cfg, EN);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.standalone]),
      [
        [id, true],
        ["a", false],
      ],
    );
  });

  it("keeps a custom entry for a layer type with no auto legend (3d-tiles)", () => {
    const cfg = setLegendCustomEntry(config(), "t", {
      items: [{ label: "Buildings", color: "#cccccc" }],
    });
    const entries = buildAutoLegend(
      [layer({ id: "t", name: "Tiles", type: "3d-tiles", source: { type: "3d-tiles" } })],
      cfg,
      EN,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].rows[0].label, "Buildings");
  });

  it("applies rename and hide overrides to entries and rows", () => {
    const styled = layer({
      id: "cat",
      name: "Era",
      metadata: { geometryType: "polygon" },
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "categorized",
        vectorStyleStops: [
          { value: "old", color: "#8c2d04" },
          { value: "new", color: "#08306b" },
        ],
      },
    });
    const cfg = config({
      overrides: {
        cat: { label: "Periods" },
        [legendRowKey("cat", 0)]: { label: "Ancient" },
        [legendRowKey("cat", 1)]: { hidden: true },
      },
    });
    const [entry] = buildAutoLegend([styled], cfg, EN);
    assert.equal(entry.name, "Periods");
    assert.equal(entry.defaultName, "Era");
    assert.equal(entry.rows[0].label, "Ancient");
    assert.equal(entry.rows[0].defaultLabel, "old");
    assert.equal(entry.rows[1].hidden, true);
  });

  it("removeLegendCustomEntry reverts to auto and prunes stale state", () => {
    let cfg = setLegendCustomEntry(config(), "a", {
      items: [{ label: "X", color: "#000000" }],
    });
    cfg = {
      ...cfg,
      order: ["a"],
      overrides: { a: { label: "Renamed" }, [legendRowKey("a", 0)]: { hidden: true } },
    };
    const next = removeLegendCustomEntry(cfg, "a");
    assert.equal(next.customEntries, undefined);
    assert.deepEqual(next.order, []);
    assert.deepEqual(next.overrides, {});
  });
});
