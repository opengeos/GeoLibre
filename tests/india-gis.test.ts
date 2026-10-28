import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INDIA_GIS_CATALOGS } from "../packages/plugins/src/plugins/india-gis-catalogs";
import { INDIA_GIS_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-india-gis";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";

describe("India GIS catalog", () => {
  it("defines state and national catalog sets with unique ids", () => {
    assert.ok(INDIA_GIS_CATALOGS.length >= 8);
    const setIds = INDIA_GIS_CATALOGS.map((set) => set.id);
    assert.equal(new Set(setIds).size, setIds.length, "Catalog set IDs must be unique");

    const catalogIds = new Set<string>();
    for (const set of INDIA_GIS_CATALOGS) {
      assert.ok(set.catalogs.length > 0, `${set.name} has at least one portal`);
      for (const catalog of set.catalogs) {
        assert.ok(!catalogIds.has(catalog.id), `Catalog id ${catalog.id} is unique`);
        catalogIds.add(catalog.id);
        assert.match(catalog.url, /^https:\/\/[^/]+$/);
        assert.ok(catalog.name.length > 0);
      }
    }
  });

  it("is registered as an official Web Services plugin", () => {
    assert.equal(INDIA_GIS_PLUGIN_ID, "geolibre-india-gis");
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(INDIA_GIS_PLUGIN_ID));
  });
});
