import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEGEND_CONFIG,
  type GeoLibreLayer,
  type LayerStyle,
  type LegendConfig,
} from "../packages/core/src/types";
import {
  applyLegendConfig,
  buildLegend,
  legendEditorRows,
  reorderLegendEntry,
  setLegendItemLabel,
  toggleLegendItemHidden,
} from "../apps/geolibre-desktop/src/lib/print-legend";

function config(overrides: Partial<LegendConfig> = {}): LegendConfig {
  return { ...DEFAULT_LEGEND_CONFIG, order: [], overrides: {}, ...overrides };
}

function makeLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Layer 1",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {} as LayerStyle,
    metadata: {},
    ...overrides,
  } as unknown as GeoLibreLayer;
}

describe("buildLegend", () => {
  it("omits hidden layers", () => {
    const legend = buildLegend([
      makeLayer({ id: "a", name: "A", visible: false }),
      makeLayer({ id: "b", name: "B", visible: true }),
    ]);
    assert.deepEqual(
      legend.map((e) => e.name),
      ["B"],
    );
  });

  it("omits 3D and media layer types", () => {
    const legend = buildLegend([
      makeLayer({ id: "a", name: "Cloud", type: "lidar" }),
      makeLayer({ id: "b", name: "Tiles", type: "3d-tiles" }),
      makeLayer({ id: "c", name: "Clip", type: "video" }),
      makeLayer({ id: "d", name: "Points", type: "geojson" }),
    ]);
    assert.deepEqual(
      legend.map((e) => e.name),
      ["Points"],
    );
  });

  it("returns layers top-of-stack first", () => {
    const legend = buildLegend([
      makeLayer({ id: "bottom", name: "Bottom" }),
      makeLayer({ id: "top", name: "Top" }),
    ]);
    assert.deepEqual(
      legend.map((e) => e.name),
      ["Top", "Bottom"],
    );
  });

  it("uses the layer fill color for single-symbol vector layers", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Parcels",
        style: { vectorStyleMode: "single", fillColor: "#ff0000" } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches.length, 1);
    assert.equal(legend[0].swatches[0].color, "#ff0000");
  });

  it("expands graduated symbology into ramp swatches with labels", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Population",
        style: {
          vectorStyleMode: "graduated",
          vectorStyleStops: [
            { value: 0, color: "#eef" },
            { value: 100, color: "#88a" },
            { value: 200, color: "#114" },
          ],
        } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches.length, 3);
    assert.equal(legend[0].swatches[0].color, "#eef");
    assert.equal(legend[0].swatches[1].label, "≥ 100");
  });

  it("caps ramp swatches at six samples", () => {
    const stops = Array.from({ length: 12 }, (_, i) => ({
      value: i,
      color: `#0000${(i % 10).toString()}0`,
    }));
    const legend = buildLegend([
      makeLayer({
        name: "Many",
        style: {
          vectorStyleMode: "categorized",
          vectorStyleStops: stops,
        } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches.length, 6);
  });

  it("gives raster and service layers a single neutral swatch", () => {
    const legend = buildLegend([
      makeLayer({ name: "Imagery", type: "raster" }),
      makeLayer({ name: "WMS", type: "wms" }),
    ]);
    assert.equal(legend.length, 2);
    assert.equal(legend[0].swatches.length, 1);
    assert.equal(legend[1].swatches.length, 1);
  });

  it("treats vector MBTiles as a vector layer using its fill color", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Vector tiles",
        type: "mbtiles",
        metadata: { tileType: "vector" },
        style: { vectorStyleMode: "single", fillColor: "#00aa55" } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches[0].color, "#00aa55");
  });

  it("gives raster MBTiles the neutral swatch", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Raster tiles",
        type: "mbtiles",
        metadata: { tileType: "raster" },
        style: { fillColor: "#00aa55" } as LayerStyle,
      }),
    ]);
    assert.notEqual(legend[0].swatches[0].color, "#00aa55");
  });

  it("treats MBTiles with no tileType as vector", () => {
    const legend = buildLegend([
      makeLayer({
        name: "Legacy tiles",
        type: "mbtiles",
        metadata: {},
        style: { vectorStyleMode: "single", fillColor: "#123456" } as LayerStyle,
      }),
    ]);
    assert.equal(legend[0].swatches[0].color, "#123456");
  });

  it("carries the source layer id on each entry", () => {
    const legend = buildLegend([makeLayer({ id: "abc", name: "A" })]);
    assert.equal(legend[0].id, "abc");
  });
});

describe("applyLegendConfig", () => {
  const base = buildLegend([
    makeLayer({ id: "bottom", name: "Bottom" }),
    makeLayer({ id: "top", name: "Top" }),
  ]);

  it("returns the auto legend unchanged with the default config", () => {
    const result = applyLegendConfig(base, config());
    assert.deepEqual(
      result.map((e) => e.name),
      ["Top", "Bottom"],
    );
  });

  it("renames an entry via a label override", () => {
    const result = applyLegendConfig(
      base,
      config({ overrides: { top: { label: "Renamed" } } }),
    );
    assert.equal(result[0].name, "Renamed");
  });

  it("hides an entry flagged hidden", () => {
    const result = applyLegendConfig(
      base,
      config({ overrides: { top: { hidden: true } } }),
    );
    assert.deepEqual(
      result.map((e) => e.name),
      ["Bottom"],
    );
  });

  it("reorders entries to follow the order list", () => {
    const result = applyLegendConfig(base, config({ order: ["bottom", "top"] }));
    assert.deepEqual(
      result.map((e) => e.name),
      ["Bottom", "Top"],
    );
  });

  it("hides individual classes and drops an entry with all classes hidden", () => {
    const graduated = buildLegend([
      makeLayer({
        id: "pop",
        name: "Population",
        style: {
          vectorStyleMode: "graduated",
          vectorStyleStops: [
            { value: 0, color: "#eef" },
            { value: 100, color: "#88a" },
          ],
        } as LayerStyle,
      }),
    ]);
    const oneHidden = applyLegendConfig(
      graduated,
      config({ overrides: { "pop::0": { hidden: true } } }),
    );
    assert.equal(oneHidden[0].swatches.length, 1);
    assert.equal(oneHidden[0].swatches[0].color, "#88a");

    const allHidden = applyLegendConfig(
      graduated,
      config({
        overrides: { "pop::0": { hidden: true }, "pop::1": { hidden: true } },
      }),
    );
    assert.equal(allHidden.length, 0);
  });

  it("trims surrounding whitespace from a rendered label", () => {
    const result = applyLegendConfig(
      base,
      config({ overrides: { top: { label: "  Spaced  " } } }),
    );
    assert.equal(result[0].name, "Spaced");
  });

  it("treats a whitespace-only label as no override", () => {
    const result = applyLegendConfig(
      base,
      config({ overrides: { top: { label: "   " } } }),
    );
    assert.equal(result[0].name, "Top");
  });

  it("renames a class label", () => {
    const categorized = buildLegend([
      makeLayer({
        id: "pop",
        name: "Population",
        style: {
          vectorStyleMode: "categorized",
          vectorStyleStops: [
            { value: "A", color: "#eef" },
            { value: "B", color: "#88a" },
          ],
        } as LayerStyle,
      }),
    ]);
    const result = applyLegendConfig(
      categorized,
      config({ overrides: { "pop::0": { label: "Class A" } } }),
    );
    assert.equal(result[0].swatches[0].label, "Class A");
    assert.equal(result[0].swatches[1].label, "B");
  });
});

describe("legendEditorRows", () => {
  it("flattens a graduated layer into an entry plus class rows", () => {
    const base = buildLegend([
      makeLayer({
        id: "pop",
        name: "Population",
        style: {
          vectorStyleMode: "graduated",
          vectorStyleStops: [
            { value: 0, color: "#eef" },
            { value: 100, color: "#88a" },
          ],
        } as LayerStyle,
      }),
    ]);
    const rows = legendEditorRows(base, config());
    assert.equal(rows.length, 3);
    assert.equal(rows[0].kind, "entry");
    assert.equal(rows[0].reorderable, true);
    assert.equal(rows[1].kind, "class");
    assert.equal(rows[1].reorderable, false);
    assert.equal(rows[1].key, "pop::0");
  });

  it("reflects overrides and keeps hidden rows visible in the editor", () => {
    const base = buildLegend([makeLayer({ id: "a", name: "A" })]);
    const rows = legendEditorRows(
      base,
      config({ overrides: { a: { label: "Renamed", hidden: true } } }),
    );
    assert.equal(rows[0].label, "Renamed");
    assert.equal(rows[0].defaultLabel, "A");
    assert.equal(rows[0].hidden, true);
  });

  it("keeps a raw override (with spaces) in the editor but falls back when blank", () => {
    const base = buildLegend([makeLayer({ id: "a", name: "A" })]);
    // A non-blank override is shown verbatim so the input can hold spaces.
    const spaced = legendEditorRows(
      base,
      config({ overrides: { a: { label: "My label " } } }),
    );
    assert.equal(spaced[0].label, "My label ");
    // A whitespace-only override is treated as no override (shows the default).
    const blank = legendEditorRows(
      base,
      config({ overrides: { a: { label: "   " } } }),
    );
    assert.equal(blank[0].label, "A");
  });
});

describe("legend config mutations", () => {
  it("sets a label and clears it when blank or equal to the default", () => {
    const set = setLegendItemLabel(config(), "a", "Custom", "A");
    assert.equal(set.overrides.a.label, "Custom");
    const cleared = setLegendItemLabel(set, "a", "  ", "A");
    assert.equal(cleared.overrides.a, undefined);
    const sameAsDefault = setLegendItemLabel(config(), "a", "A", "A");
    assert.equal(sameAsDefault.overrides.a, undefined);
  });

  it("preserves a hidden flag when the label is cleared", () => {
    const hidden = toggleLegendItemHidden(config(), "a");
    const cleared = setLegendItemLabel(hidden, "a", "", "A");
    assert.equal(cleared.overrides.a.hidden, true);
    assert.equal(cleared.overrides.a.label, undefined);
  });

  it("toggles the hidden flag and prunes when toggled back off", () => {
    const on = toggleLegendItemHidden(config(), "a");
    assert.equal(on.overrides.a.hidden, true);
    const off = toggleLegendItemHidden(on, "a");
    assert.equal(off.overrides.a, undefined);
  });

  it("reorders an entry and writes the full order list", () => {
    const moved = reorderLegendEntry(config(), ["top", "bottom"], "bottom", "up");
    assert.deepEqual(moved.order, ["bottom", "top"]);
  });

  it("ignores a move past the ends", () => {
    const unchanged = reorderLegendEntry(config(), ["top", "bottom"], "top", "up");
    assert.deepEqual(unchanged.order, []);
  });
});
