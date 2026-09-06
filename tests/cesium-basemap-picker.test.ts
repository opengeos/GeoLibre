import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  availableCesiumBasemap,
  basemapToCesiumImagery,
  CESIUM_BASEMAPS,
  normalizeCesiumBasemap,
  sameCesiumImagery,
} from "../packages/core/src/cesium-imagery";
import { createEmptyProject, parseProject, serializeProject } from "../packages/core/src/project";

describe("Cesium basemap choices", () => {
  it("keeps stable unique IDs and normalizes unrecognized project values", () => {
    assert.equal(new Set(CESIUM_BASEMAPS.map((entry) => entry.id)).size, CESIUM_BASEMAPS.length);
    for (const value of [undefined, null, {}, "unknown", 3954]) {
      assert.equal(normalizeCesiumBasemap(value), "project");
    }
    for (const entry of CESIUM_BASEMAPS) assert.equal(normalizeCesiumBasemap(entry.id), entry.id);
  });

  it("gates only ion-backed imagery on credentials", () => {
    for (const entry of CESIUM_BASEMAPS) {
      assert.equal(availableCesiumBasemap(entry.id, true), entry.id);
      assert.equal(
        availableCesiumBasemap(entry.id, false),
        "assetId" in entry ? "project" : entry.id,
      );
    }
  });

  it("resolves overrides independently from the MapLibre background", () => {
    assert.deepEqual(basemapToCesiumImagery("geolibre://blank", "natural-earth"), {
      kind: "natural-earth",
    });
    assert.deepEqual(basemapToCesiumImagery(undefined, "sentinel-2"), {
      kind: "ion",
      assetId: 3954,
    });
    const osm = basemapToCesiumImagery(undefined, "osm");
    assert.equal(osm.kind, "xyz");
    if (osm.kind === "xyz")
      assert.equal(osm.template, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    assert.deepEqual(
      basemapToCesiumImagery(undefined, "project"),
      basemapToCesiumImagery(undefined),
    );
  });

  it("does not treat different ion assets as the same background", () => {
    assert.equal(
      sameCesiumImagery({ kind: "ion", assetId: 2 }, { kind: "ion", assetId: 3 }),
      false,
    );
    assert.equal(sameCesiumImagery({ kind: "ion", assetId: 2 }, { kind: "ion", assetId: 2 }), true);
    assert.equal(sameCesiumImagery({ kind: "natural-earth" }, { kind: "default" }), false);
  });

  it("round-trips the imagery and terrain selection through saved projects", () => {
    const project = createEmptyProject();
    project.preferences!.map.cesiumBasemap = "blue-marble";
    project.preferences!.map.terrainEnabled = true;
    const restored = parseProject(serializeProject(project));
    assert.equal(restored.preferences?.map.cesiumBasemap, "blue-marble");
    assert.equal(restored.preferences?.map.terrainEnabled, true);
    const invalid = JSON.parse(serializeProject(project));
    invalid.preferences.map.cesiumBasemap = "unrecognized-provider";
    assert.equal(parseProject(JSON.stringify(invalid)).preferences?.map.cesiumBasemap, "project");
    delete invalid.preferences.map.cesiumBasemap;
    assert.equal(parseProject(JSON.stringify(invalid)).preferences?.map.cesiumBasemap, "project");
  });
});
