import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ARCGIS_PROJECTION_PRESETS,
  createEmptyProject,
  normalizeArcgisWkid,
  parseProject,
  serializeProject,
} from "@geolibre/core";
import { arcgisPointLngLat, arcgisSceneMode } from "../packages/map/src/arcgis-engine";
import {
  loadArcgisProjectOperator,
  resetArcgisSdkForTests,
  type ArcgisPoint,
  type ArcgisProjectOperator,
} from "../packages/map/src/arcgis-sdk";

const en = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url)),
    "utf8",
  ),
);

// The ArcGIS renderer's flat map in a projection other than Web Mercator,
// e.g. Spilhaus (issue #2708).

const point = (fields: Partial<ArcgisPoint>): ArcgisPoint =>
  ({ type: "point", x: 0, y: 0, spatialReference: {}, ...fields }) as ArcgisPoint;

describe("normalizeArcgisWkid", () => {
  it("keeps positive integer WKIDs, including numeric strings", () => {
    assert.equal(normalizeArcgisWkid(54099), 54099);
    assert.equal(normalizeArcgisWkid("54030"), 54030);
    assert.equal(normalizeArcgisWkid(4326), 4326);
  });
  it("treats absent, malformed and Web Mercator codes as the default map", () => {
    for (const value of [
      undefined,
      null,
      "",
      "abc",
      "1e3",
      "0x10",
      "-5",
      "99999999999999999999",
      0,
      -1,
      1.5,
      Number.NaN,
      {},
      3857,
      102100,
    ])
      assert.equal(normalizeArcgisWkid(value), undefined, String(value));
  });
  it("offers unique presets with translated names", () => {
    const wkids = ARCGIS_PROJECTION_PRESETS.map((preset) => preset.wkid);
    assert.equal(new Set(wkids).size, wkids.length);
    assert.ok(wkids.includes(54099), "Spilhaus is a preset");
    const names = en.settings.map.arcgisProjections as Record<string, string>;
    for (const preset of ARCGIS_PROJECTION_PRESETS)
      assert.equal(names[preset.id], preset.name, preset.id);
  });
});

describe("arcgisWkid in the project file", () => {
  it("round-trips a WKID and drops a Web Mercator or malformed one", () => {
    const project = createEmptyProject();
    project.preferences.map.arcgisWkid = 54099;
    assert.equal(parseProject(serializeProject(project)).preferences.map.arcgisWkid, 54099);
    for (const value of [3857, "nope"]) {
      (project.preferences.map as { arcgisWkid?: unknown }).arcgisWkid = value;
      assert.equal(parseProject(serializeProject(project)).preferences.map.arcgisWkid, undefined);
    }
    delete project.preferences.map.arcgisWkid;
    assert.equal(parseProject(serializeProject(project)).preferences.map.arcgisWkid, undefined);
  });
});

describe("arcgisPointLngLat", () => {
  const operator: ArcgisProjectOperator = {
    load: async () => {},
    isLoaded: () => true,
    execute: <T>(geometry: T) => {
      const p = geometry as ArcgisPoint;
      if (p.x > 1e9) throw new Error("outside the projection's domain");
      return { x: p.x / 1000, y: p.y / 1000 } as T;
    },
    executeMany: () => [],
  };
  it("reads longitude/latitude when the point has them", () => {
    assert.deepEqual(arcgisPointLngLat(point({ longitude: 10, latitude: 20 })), [10, 20]);
  });
  it("projects a point in another projection, which has no longitude", () => {
    const spilhaus = point({
      x: 5000,
      y: -3000,
      longitude: null as never,
      latitude: null as never,
    });
    assert.equal(arcgisPointLngLat(spilhaus), null);
    assert.deepEqual(arcgisPointLngLat(spilhaus, operator), [5, -3]);
  });
  it("answers null for no point or one that cannot be projected", () => {
    assert.equal(arcgisPointLngLat(null, operator), null);
    assert.equal(arcgisPointLngLat(point({ x: 2e9 }), operator), null);
  });
});

describe("loadArcgisProjectOperator", () => {
  it("loads the operator after the core SDK, once", async () => {
    resetArcgisSdkForTests();
    const requested: string[] = [];
    let loads = 0;
    const importer = async (url: string) => {
      const module = url.split("/@arcgis/core/")[1];
      requested.push(module);
      if (module === "config.js") return { default: { apiKey: null } };
      if (module === "geometry/operators/projectOperator.js") {
        let loaded = false;
        return {
          isLoaded: () => loaded,
          load: async () => {
            loads++;
            loaded = true;
          },
          execute: () => null,
        };
      }
      if (/^(core|geometry\/support)\//.test(module)) return { watch() {} };
      return { default: class {} };
    };
    const operator = await loadArcgisProjectOperator(importer);
    assert.equal(operator.isLoaded(), true);
    assert.equal(loads, 1);
    assert.equal(requested.at(-1), "geometry/operators/projectOperator.js");
    assert.ok(requested.includes("views/MapView.js"));
    assert.equal(await loadArcgisProjectOperator(importer), operator);
    assert.equal(loads, 1);
    resetArcgisSdkForTests();
  });
});

describe("arcgisSceneMode with a custom projection", () => {
  it("keeps a projected flat map a MapView even with terrain on", () => {
    assert.equal(arcgisSceneMode("mercator", true, true), "2d");
    assert.equal(arcgisSceneMode("mercator", false, true), "2d");
    assert.equal(arcgisSceneMode("globe", true, true), "global");
    assert.equal(arcgisSceneMode("mercator", true), "local");
  });
});
