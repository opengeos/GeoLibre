import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PRINT_LAYOUT,
  createDefaultPrintLayout,
  isDefaultPrintLayout,
  normalizePrintLayoutConfig,
  printLayoutConfigsEqual,
  scrubPrintLayoutForLayers,
  scrubPrintLayoutForRemovedLayers,
  type PrintLayoutConfig,
} from "../packages/core/src/print-layout-config";

it("normalizes fixed MGRS intervals to the supported kilometre precision", () => {
  assert.equal(
    normalizePrintLayoutConfig({ gridType: "mgrs", gridInterval: 500 })?.gridInterval,
    1000,
  );
  assert.equal(normalizePrintLayoutConfig({ gridType: "mgrs", gridInterval: 0 })?.gridInterval, 0);
  assert.equal(normalizePrintLayoutConfig({ gridInterval: Infinity })?.gridInterval, 0);
  assert.equal(normalizePrintLayoutConfig({ gridInterval: -1 })?.gridInterval, 0);
});

// The Print Layout composer's settings describe the project's map document, so
// they round-trip through `.geolibre.json`. Before GeoLibre discussion #1992
// they lived only in the dialog's component state: reopening a project lost the
// title, page format and orientation, and the composer kept showing the
// settings of whichever project had been open before.

const withOverrides = (overrides: Partial<PrintLayoutConfig>): PrintLayoutConfig => ({
  ...createDefaultPrintLayout(),
  ...overrides,
});

describe("normalizePrintLayoutConfig", () => {
  it("reports no config for a project that carries none", () => {
    assert.equal(normalizePrintLayoutConfig(undefined), null);
    assert.equal(normalizePrintLayoutConfig(null), null);
    assert.equal(normalizePrintLayoutConfig("a4"), null);
    // An array is an object but never a config.
    assert.equal(normalizePrintLayoutConfig([]), null);
  });

  it("fills a partial config out from the defaults", () => {
    const config = normalizePrintLayoutConfig({ title: "Dentists by region", paperSize: "a3" });
    assert.ok(config);
    assert.equal(config.title, "Dentists by region");
    assert.equal(config.paperSize, "a3");
    // Untouched fields keep their defaults rather than arriving undefined.
    assert.equal(config.orientation, DEFAULT_PRINT_LAYOUT.orientation);
    assert.equal(config.showNorthArrow, DEFAULT_PRINT_LAYOUT.showNorthArrow);
    assert.deepEqual(config.tableColumns, []);
    // A project saved before the page background existed keeps a white page.
    assert.equal(config.pageBackground, "#ffffff");
  });

  it("keeps only a hex page background", () => {
    for (const [raw, kept] of [
      ["#0d1b2a", "#0d1b2a"],
      [" #0D1 ", "#0D1"],
      ["navy", "#ffffff"],
      ["red;", "#ffffff"],
      ["#0d1b2", "#ffffff"],
      [42, "#ffffff"],
    ] as const) {
      assert.equal(
        normalizePrintLayoutConfig({ pageBackground: raw })?.pageBackground,
        kept,
        String(raw),
      );
    }
  });

  it("round-trips every field of a fully populated config", () => {
    const saved = withOverrides({
      title: "Filière dentaire",
      subtitle: "2026",
      titlePlacement: "inside",
      titleAlign: "left",
      paperSize: "custom",
      orientation: "portrait",
      customWidth: 900,
      customHeight: 1600,
      customUnit: "mm",
      pageBackground: "#0d1b2a",
      panelTheme: "dark",
      showLegend: false,
      showColorbar: true,
      colorbarRamp: "magma",
      colorbarPosition: "bottom-left",
      showCustomLegend: true,
      customLegendEntries: [{ id: "cl-7", label: "max : 9133", color: "#f97316" }],
      showDataTable: true,
      tableLayerId: "layer-a",
      tableColumns: ["name", "count"],
      tableMaxRows: 25,
      showDataChart: true,
      chartLayerId: "layer-b",
      chartType: "pie",
      captureMode: "extent",
      extentBbox: [-5, 41, 9, 52],
      atlasEnabled: true,
      atlasLayerId: "layer-c",
      atlasMarginPct: 15,
    });
    assert.deepEqual(normalizePrintLayoutConfig(saved), saved);
  });

  it("falls back to the default for an unknown enum value", () => {
    const config = normalizePrintLayoutConfig({
      paperSize: "a0",
      orientation: "sideways",
      tablePosition: "middle",
      chartType: "sunburst",
      panelTheme: "sepia",
    });
    assert.ok(config);
    assert.equal(config.panelTheme, "light");
    assert.equal(config.paperSize, DEFAULT_PRINT_LAYOUT.paperSize);
    assert.equal(config.orientation, DEFAULT_PRINT_LAYOUT.orientation);
    assert.equal(config.tablePosition, DEFAULT_PRINT_LAYOUT.tablePosition);
    assert.equal(config.chartType, DEFAULT_PRINT_LAYOUT.chartType);
  });

  it("clamps out-of-range numbers and rejects non-finite ones", () => {
    const config = normalizePrintLayoutConfig({
      colorbarLength: 400,
      atlasMarginPct: -8,
      mapBorderWidth: Number.NaN,
      tableMaxRows: 0,
    });
    assert.ok(config);
    assert.equal(config.colorbarLength, 100);
    assert.equal(config.atlasMarginPct, 0);
    assert.equal(config.mapBorderWidth, DEFAULT_PRINT_LAYOUT.mapBorderWidth);
    assert.equal(config.tableMaxRows, 1);
  });

  it("keeps only well-formed custom legend entries and supplies missing ids", () => {
    const config = normalizePrintLayoutConfig({
      customLegendEntries: [
        { id: "cl-4", label: "Class 4", color: "#123456" },
        { label: "No id", color: "#654321" },
        "not an entry",
        null,
      ],
    });
    assert.ok(config);
    assert.deepEqual(config.customLegendEntries, [
      { id: "cl-4", label: "Class 4", color: "#123456" },
      { id: "cl-2", label: "No id", color: "#654321" },
    ]);
  });

  it("keeps synthesized legend ids clear of ids claimed elsewhere in the array", () => {
    // The editor keys swatch rows by id, so a duplicate would make an edit to
    // one row apply to the other. The entry missing an id would otherwise be
    // synthesized as "cl-1", which the second entry already claims.
    const config = normalizePrintLayoutConfig({
      customLegendEntries: [
        { label: "First", color: "#111111" },
        { id: "cl-1", label: "Second", color: "#222222" },
      ],
    });
    assert.deepEqual(
      config?.customLegendEntries.map((entry) => entry.id),
      ["cl-2", "cl-1"],
    );

    // A file that simply repeats an id gets the later one renamed.
    const repeated = normalizePrintLayoutConfig({
      customLegendEntries: [
        { id: "cl-3", label: "A", color: "#111111" },
        { id: "cl-3", label: "B", color: "#222222" },
      ],
    });
    assert.deepEqual(
      repeated?.customLegendEntries.map((entry) => entry.id),
      ["cl-3", "cl-2"],
    );
  });

  it("drops a malformed print extent rather than drawing from it", () => {
    assert.equal(normalizePrintLayoutConfig({ extentBbox: [1, 2, 3] })?.extentBbox, null);
    assert.equal(normalizePrintLayoutConfig({ extentBbox: [1, 2, "3", 4] })?.extentBbox, null);
    assert.deepEqual(
      normalizePrintLayoutConfig({ extentBbox: [1, 2, 3, 4] })?.extentBbox,
      [1, 2, 3, 4],
    );
  });

  it("drops an inverted or zero-area extent, which would capture nothing", () => {
    assert.equal(normalizePrintLayoutConfig({ extentBbox: [9, 2, 1, 4] })?.extentBbox, null);
    assert.equal(normalizePrintLayoutConfig({ extentBbox: [1, 9, 3, 4] })?.extentBbox, null);
    assert.equal(normalizePrintLayoutConfig({ extentBbox: [1, 2, 1, 4] })?.extentBbox, null);
    assert.equal(normalizePrintLayoutConfig({ extentBbox: [1, 2, 3, 2] })?.extentBbox, null);
  });

  it("keeps a page border at a width that actually draws", () => {
    assert.equal(normalizePrintLayoutConfig({ pageBorderWidth: 0 })?.pageBorderWidth, 1);
    assert.equal(normalizePrintLayoutConfig({ pageBorderWidth: 4 })?.pageBorderWidth, 4);
    // Export resolution: only the offered DPIs survive a load (GH #3523).
    assert.equal(normalizePrintLayoutConfig({ exportDpi: 300 })?.exportDpi, 300);
    assert.equal(normalizePrintLayoutConfig({ exportDpi: 600 })?.exportDpi, 150);
    assert.equal(normalizePrintLayoutConfig({ exportDpi: "150" })?.exportDpi, 150);
    assert.equal(normalizePrintLayoutConfig({})?.exportDpi, 150);
  });

  it("filters non-string table columns", () => {
    const config = normalizePrintLayoutConfig({ tableColumns: ["name", 7, null, "count"] });
    assert.deepEqual(config?.tableColumns, ["name", "count"]);
  });
});

describe("createDefaultPrintLayout", () => {
  it("hands out copies, so one project's edits cannot leak into another", () => {
    const first = createDefaultPrintLayout();
    const second = createDefaultPrintLayout();
    first.customLegendEntries[0].label = "Edited";
    first.tableColumns.push("name");
    assert.equal(second.customLegendEntries[0].label, "Class 1");
    assert.deepEqual(second.tableColumns, []);
    assert.equal(DEFAULT_PRINT_LAYOUT.customLegendEntries[0].label, "Class 1");
  });
});

describe("isDefaultPrintLayout", () => {
  it("recognizes an untouched composer, so the project file stays free of the key", () => {
    assert.equal(isDefaultPrintLayout(createDefaultPrintLayout()), true);
  });

  it("recognizes any edit, including one inside an array field", () => {
    assert.equal(isDefaultPrintLayout(withOverrides({ orientation: "portrait" })), false);
    assert.equal(isDefaultPrintLayout(withOverrides({ tableColumns: ["name"] })), false);
    assert.equal(
      isDefaultPrintLayout(
        withOverrides({ customLegendEntries: [{ id: "cl-1", label: "A", color: "#000000" }] }),
      ),
      false,
    );
  });
});

describe("printLayoutConfigsEqual", () => {
  it("compares by value so a rebuilt but unchanged config is not a store write", () => {
    assert.equal(
      printLayoutConfigsEqual(createDefaultPrintLayout(), createDefaultPrintLayout()),
      true,
    );
    assert.equal(
      printLayoutConfigsEqual(
        withOverrides({ title: "Map", extentBbox: [1, 2, 3, 4] }),
        withOverrides({ title: "Map", extentBbox: [1, 2, 3, 4] }),
      ),
      true,
    );
  });

  it("sees a difference in any field", () => {
    assert.equal(
      printLayoutConfigsEqual(createDefaultPrintLayout(), withOverrides({ title: "Map" })),
      false,
    );
    assert.equal(
      printLayoutConfigsEqual(
        withOverrides({ extentBbox: [1, 2, 3, 4] }),
        withOverrides({ extentBbox: [1, 2, 3, 5] }),
      ),
      false,
    );
  });
});

describe("scrubPrintLayoutForLayers", () => {
  it("leaves a config whose blocks all name surviving layers untouched", () => {
    const config = withOverrides({
      showDataTable: true,
      tableLayerId: "keep",
      showDataChart: true,
      chartLayerId: "keep",
    });
    assert.equal(scrubPrintLayoutForLayers(config, new Set(["keep"])), config);
  });

  it("clears a block that points at a layer the project no longer carries", () => {
    const config = withOverrides({
      showDataTable: true,
      tableLayerId: "gone",
      showDataChart: true,
      chartLayerId: "keep",
      atlasEnabled: true,
      atlasLayerId: "gone",
    });
    const scrubbed = scrubPrintLayoutForLayers(config, new Set(["keep"]));
    assert.equal(scrubbed.tableLayerId, "");
    assert.equal(scrubbed.showDataTable, false);
    assert.equal(scrubbed.atlasLayerId, "");
    assert.equal(scrubbed.atlasEnabled, false);
    // The block that still resolves keeps both its layer and its visibility.
    assert.equal(scrubbed.chartLayerId, "keep");
    assert.equal(scrubbed.showDataChart, true);
  });

  it("treats an unset block as nothing to scrub", () => {
    const config = createDefaultPrintLayout();
    assert.equal(scrubPrintLayoutForLayers(config, new Set()), config);
  });
});

describe("scrubPrintLayoutForRemovedLayers", () => {
  it("clears the blocks built on a removed layer and leaves the rest alone", () => {
    const config = withOverrides({
      showDataTable: true,
      tableLayerId: "gone",
      showDataChart: true,
      chartLayerId: "kept",
      atlasEnabled: true,
      atlasLayerId: "gone",
    });
    const scrubbed = scrubPrintLayoutForRemovedLayers(config, "gone");
    assert.equal(scrubbed.tableLayerId, "");
    assert.equal(scrubbed.showDataTable, false);
    assert.equal(scrubbed.atlasLayerId, "");
    assert.equal(scrubbed.atlasEnabled, false);
    assert.equal(scrubbed.chartLayerId, "kept");
    assert.equal(scrubbed.showDataChart, true);
  });

  it("accepts a set of ids, as a group delete passes", () => {
    const config = withOverrides({ showDataChart: true, chartLayerId: "b" });
    const scrubbed = scrubPrintLayoutForRemovedLayers(config, new Set(["a", "b"]));
    assert.equal(scrubbed.chartLayerId, "");
    assert.equal(scrubbed.showDataChart, false);
  });

  it("returns the same object when no block named a removed layer", () => {
    const config = withOverrides({ showDataTable: true, tableLayerId: "kept" });
    assert.equal(scrubPrintLayoutForRemovedLayers(config, "gone"), config);
    assert.equal(scrubPrintLayoutForRemovedLayers(config, []), config);
  });
});

describe("cartographic extras (GH #3530)", () => {
  it("opens a layout saved before them in the automatic arrangement", () => {
    const config = normalizePrintLayoutConfig({ title: "Old", paperSize: "a3" });
    assert.ok(config);
    assert.equal(config.mapFrameBox, null);
    assert.equal(config.insetBox, null);
    assert.deepEqual(config.elementOffsets, {});
    assert.equal(config.showInset, false);
    assert.equal(config.showGrid, false);
    assert.equal(config.gridType, "dms");
    assert.equal(config.gridInterval, 0);
  });

  it("round-trips the inset, grid and arrangement", () => {
    const saved = withOverrides({
      showInset: true,
      insetBasemap: "osm",
      insetZoomOffset: -6,
      insetExtentColor: "#2563eb",
      insetBox: { x: 0.05, y: 0.6, w: 0.25, h: 0.3 },
      showGrid: true,
      gridType: "mgrs",
      gridInterval: 5000,
      gridFontSize: 9,
      gridLines: true,
      mapFrameBox: { x: 0.1, y: 0.15, w: 0.8, h: 0.7 },
      elementOffsets: {
        legend: { dx: 0.02, dy: -0.01, scale: 1.25 },
        northArrow: { dx: -0.1, dy: 0.05, scale: 0.5 },
      },
    });
    assert.deepEqual(normalizePrintLayoutConfig(JSON.parse(JSON.stringify(saved))), saved);
  });

  it("drops or clamps malformed boxes and offsets from a hand-edited file", () => {
    const config = normalizePrintLayoutConfig({
      insetBasemap: "satellite",
      insetZoomOffset: 3,
      gridType: "geohash",
      insetBox: { x: 0.9, y: -1, w: 0.5, h: 0.5 },
      mapFrameBox: { x: 0, y: 0, w: "wide", h: 1 },
      elementOffsets: {
        legend: { dx: 5, dy: 0, scale: 100 },
        title: { dx: 0, dy: 0 },
        compass: { dx: 0, dy: 0, scale: 1 },
      },
    });
    assert.ok(config);
    assert.equal(config.insetBasemap, "positron");
    assert.equal(config.insetZoomOffset, 0);
    assert.equal(config.gridType, "dms");
    assert.deepEqual(config.insetBox, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
    assert.equal(config.mapFrameBox, null);
    assert.deepEqual(config.elementOffsets, { legend: { dx: 1, dy: 0, scale: 4 } });
  });

  it("compares offsets by value regardless of key order", () => {
    const a = withOverrides({
      elementOffsets: { legend: { dx: 0.1, dy: 0, scale: 1 }, title: { dx: 0, dy: 0.1, scale: 1 } },
    });
    const b = withOverrides({
      elementOffsets: { title: { scale: 1, dy: 0.1, dx: 0 }, legend: { dx: 0.1, dy: 0, scale: 1 } },
    });
    assert.equal(printLayoutConfigsEqual(a, b), true);
    assert.equal(isDefaultPrintLayout(a), false);
  });
});
