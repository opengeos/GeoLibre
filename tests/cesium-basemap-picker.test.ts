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
import { DEFAULT_PROJECT_PREFERENCES } from "../packages/core/src/types";

describe("Cesium basemap choices", () => {
  it("gives new projects Bing Aerial and leaves legacy projects on their own basemap", () => {
    // A new project carries the default and saves it explicitly.
    assert.equal(DEFAULT_PROJECT_PREFERENCES.map.cesiumBasemap, "bing-aerial");
    const fresh = JSON.parse(serializeProject(createEmptyProject()));
    assert.equal(fresh.preferences.map.cesiumBasemap, "bing-aerial");
    assert.equal(parseProject(JSON.stringify(fresh)).preferences?.map.cesiumBasemap, "bing-aerial");

    // A project written before the field existed chose nothing, so loading it
    // must not repaint its globe — the policy `mapboxStyleUrl` documents four
    // lines above the same fallback.
    const legacy = JSON.parse(serializeProject(createEmptyProject()));
    delete legacy.preferences.map.cesiumBasemap;
    assert.equal(parseProject(JSON.stringify(legacy)).preferences?.map.cesiumBasemap, "project");

    // With no stored choice at all, the render-time gate still prefers Ion
    // imagery when a token is configured.
    assert.equal(availableCesiumBasemap(undefined, true), "bing-aerial");
    assert.equal(availableCesiumBasemap(undefined, false), "project");
  });

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

  it("includes the eight Other providers without requiring an ion token", () => {
    const other = CESIUM_BASEMAPS.filter(
      (entry) => "category" in entry && entry.category === "Other",
    );
    assert.deepEqual(
      other.map((entry) => entry.id),
      [
        "esri-imagery",
        "esri-hillshade",
        "esri-ocean",
        "osm",
        "stadia-watercolor",
        "stadia-toner",
        "stadia-smooth",
        "stadia-dark",
      ],
    );
    for (const entry of other) {
      assert.equal(availableCesiumBasemap(entry.id, false), entry.id);
      const project = createEmptyProject();
      project.preferences!.map.cesiumBasemap = entry.id;
      assert.equal(
        parseProject(serializeProject(project)).preferences?.map.cesiumBasemap,
        entry.id,
      );
    }
  });

  it("resolves public Esri services and keeps distinct services distinct", () => {
    const imagery = basemapToCesiumImagery(undefined, "esri-imagery");
    const hillshade = basemapToCesiumImagery(undefined, "esri-hillshade");
    assert.deepEqual(imagery, {
      kind: "arcgis",
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
    });
    assert.equal(sameCesiumImagery(imagery, hillshade), false);
    assert.equal(
      sameCesiumImagery(imagery, basemapToCesiumImagery(undefined, "esri-imagery")),
      true,
    );
  });

  it("uses the correct Stadia image formats, zoom limits and attribution", () => {
    for (const id of [
      "stadia-watercolor",
      "stadia-toner",
      "stadia-smooth",
      "stadia-dark",
    ] as const) {
      const imagery = basemapToCesiumImagery(undefined, id);
      assert.equal(imagery.kind, "xyz");
      if (imagery.kind !== "xyz") continue;
      assert.equal(imagery.apiKeyProvider, "stadia");
      assert.ok(imagery.template.endsWith(id === "stadia-watercolor" ? ".jpg" : ".png"));
      assert.equal(imagery.maximumLevel, id === "stadia-watercolor" ? 16 : 20);
      assert.match(imagery.attribution, /Stadia Maps.*OpenMapTiles.*OpenStreetMap/);
      assert.equal(
        imagery.attribution.includes("Stamen Design"),
        id === "stadia-watercolor" || id === "stadia-toner",
      );
      assert.ok(
        !imagery.template.includes("api_key"),
        "credentials are supplied only at render time",
      );
      assert.equal(sameCesiumImagery(imagery, { ...imagery, apiKeyProvider: undefined }), false);
    }
  });

  it("does not treat different ion assets as the same background", () => {
    assert.equal(
      sameCesiumImagery({ kind: "ion", assetId: 2 }, { kind: "ion", assetId: 3 }),
      false,
    );
    assert.equal(sameCesiumImagery({ kind: "ion", assetId: 2 }, { kind: "ion", assetId: 2 }), true);
    assert.equal(sameCesiumImagery({ kind: "natural-earth" }, { kind: "default" }), false);
  });

  it("hands a new project its own preferences rather than the shared defaults", () => {
    const project = createEmptyProject();
    project.preferences!.map.cesiumBasemap = "blue-marble";
    // The constant must be untouched: `normalizeProjectPreferences` reads it for
    // the default a project omitting the field gets, so sharing the object let
    // one edited project redefine the default for every later one.
    assert.equal(DEFAULT_PROJECT_PREFERENCES.map.cesiumBasemap, "bing-aerial");
    assert.notEqual(createEmptyProject().preferences!.map.cesiumBasemap, "blue-marble");
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
    // No stored choice stays no stored choice, rather than acquiring the
    // new-project default on load.
    assert.equal(parseProject(JSON.stringify(invalid)).preferences?.map.cesiumBasemap, "project");
  });
});
