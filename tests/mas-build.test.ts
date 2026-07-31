import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IS_MAS_BUILD } from "../apps/geolibre-desktop/src/lib/build-flags";
import {
  MAS_HIDDEN_DATA_SOURCES,
  MAS_HIDDEN_MENU_ITEMS,
  masHidesDataSource,
  masHidesMenuItem,
  shapefileCompanionPathsFromSelection,
} from "../apps/geolibre-desktop/src/lib/mas-build";

describe("Mac App Store build flag", () => {
  it("is false when the Vite define is absent (plain Node, and every non-MAS build)", () => {
    assert.equal(IS_MAS_BUILD, false);
  });
});

describe("masHidesDataSource", () => {
  it("hides the sidecar/martin-only sources in the MAS build", () => {
    assert.equal(masHidesDataSource("postgres", true), true);
    assert.equal(masHidesDataSource("gdb", true), true);
  });

  it("keeps client-capable sources in the MAS build", () => {
    for (const id of ["vector", "raster", "pmtiles", "duckdb", "mbtiles", "wms"]) {
      assert.equal(masHidesDataSource(id, true), false, id);
    }
  });

  it("hides nothing outside the MAS build", () => {
    for (const id of MAS_HIDDEN_DATA_SOURCES) {
      assert.equal(masHidesDataSource(id, false), false, id);
    }
    // The default flag argument is the real build flag, false under Node.
    assert.equal(masHidesDataSource("postgres"), false);
  });
});

describe("masHidesMenuItem", () => {
  it("hides only the sidecar-only menu items in the MAS build", () => {
    assert.equal(masHidesMenuItem("processing.segmentation", true), true);
    // Client-side AI tools and WASM/browser engines stay available.
    for (const id of [
      "processing.whitebox",
      "processing.conversion",
      "processing.raster",
      "processing.vector",
      "processing.notebook",
      "processing.sqlWorkspace",
      "processing.objectDetection",
      "processing.segmentEverything",
    ]) {
      assert.equal(masHidesMenuItem(id, true), false, id);
    }
  });

  it("hides nothing outside the MAS build", () => {
    for (const id of MAS_HIDDEN_MENU_ITEMS) {
      assert.equal(masHidesMenuItem(id, false), false, id);
    }
    assert.equal(masHidesMenuItem("processing.segmentation"), false);
  });
});

describe("shapefileCompanionPathsFromSelection", () => {
  const shp = "/data/parcels/Parcels.shp";

  it("matches same-directory, same-base companions case-insensitively", () => {
    const selection = [
      shp,
      "/data/parcels/parcels.DBF",
      "/data/parcels/Parcels.prj",
      "/data/parcels/PARCELS.shx",
      "/data/parcels/Parcels.cpg",
    ];
    assert.deepEqual(shapefileCompanionPathsFromSelection(shp, selection), selection.slice(1));
  });

  it("ignores the .shp itself, other bases, other directories, and non-companion extensions", () => {
    const selection = [
      shp,
      "/data/parcels/roads.dbf",
      "/data/other/Parcels.dbf",
      "/data/parcels/Parcels.shp.xml",
      "/data/parcels/Parcels.qmd",
      "/data/parcels/Parcels",
    ];
    assert.deepEqual(shapefileCompanionPathsFromSelection(shp, selection), []);
  });

  it("matches dotted base names on the last extension only", () => {
    const dotted = "/data/a.b/my.parcels.shp";
    const selection = [dotted, "/data/a.b/my.parcels.dbf", "/data/a.b/my.other.dbf"];
    assert.deepEqual(shapefileCompanionPathsFromSelection(dotted, selection), [
      "/data/a.b/my.parcels.dbf",
    ]);
  });
});
