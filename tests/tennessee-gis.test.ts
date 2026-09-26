import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arcGisHubItemPageUrl,
  buildArcGisHubSearchUrl,
  fetchArcGisHubSiteGroups,
} from "../packages/plugins/src/plugins/arcgis-hub-api";
import {
  maplibreArcGisHubPlugin,
  ARCGIS_HUB_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-arcgis-hub";
import {
  maplibreTennesseeGisPlugin,
  TENNESSEE_GIS_CATALOG_GROUPS,
  TENNESSEE_GIS_PLUGIN_ID,
  TENNESSEE_GIS_PORTAL_URL,
  TENNESSEE_GIS_SITE_ID,
} from "../packages/plugins/src/plugins/maplibre-tennessee-gis";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";

const GROUP_A = "679309d9cf42408d86ab2d2af89c369a";
const GROUP_B = "76d68999556b4897a78370d93da9418b";

describe("Hub site-scoped search", () => {
  it("scopes a search to the site's catalog groups", () => {
    const q = new URL(
      buildArcGisHubSearchUrl("roads", { groups: [GROUP_A, GROUP_B] }),
    ).searchParams.get("q");
    assert.match(q ?? "", /^\(roads\) AND \(type:/);
    assert.match(
      q ?? "",
      new RegExp(`AND \\(group:${GROUP_A} OR group:${GROUP_B}\\) AND access:public$`),
    );
  });

  it("drops malformed group ids instead of splicing them into the query", () => {
    const q = new URL(
      buildArcGisHubSearchUrl("roads", { groups: [GROUP_A, "x) OR (owner:someone"] }),
    ).searchParams.get("q");
    assert.match(q ?? "", new RegExp(`\\(group:${GROUP_A}\\)`));
    assert.doesNotMatch(q ?? "", /owner/);
  });

  it("searches the configured item types", () => {
    const q = new URL(
      buildArcGisHubSearchUrl("imagery", { types: ["Map Service", "Image Service"] }),
    ).searchParams.get("q");
    assert.equal(q, '(imagery) AND (type:"Map Service" OR type:"Image Service") AND access:public');
  });

  it("lists a keyword-less catalog by title rather than relevance", () => {
    const browse = new URL(buildArcGisHubSearchUrl("", { groups: [GROUP_A] }));
    assert.equal(browse.searchParams.get("sortField"), "title");
    assert.equal(browse.searchParams.get("sortOrder"), "asc");
    assert.match(browse.searchParams.get("q") ?? "", /^\(type:/);
    const keyword = new URL(buildArcGisHubSearchUrl("roads"));
    assert.equal(keyword.searchParams.get("sortField"), "relevance");
  });

  it("opens Details on the site's own dataset page", () => {
    assert.equal(
      arcGisHubItemPageUrl({ id: "abc" }, TENNESSEE_GIS_PORTAL_URL),
      "https://geodata.tn.gov/datasets/abc/about",
    );
    assert.equal(arcGisHubItemPageUrl({ id: "abc" }), "https://hub.arcgis.com/datasets/abc/about");
  });

  it("reads catalog groups from the Hub site item", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({ catalog: { groups: [GROUP_A, 42, "not-a-group", GROUP_B] } });
    }) as typeof fetch;
    try {
      const groups = await fetchArcGisHubSiteGroups(TENNESSEE_GIS_SITE_ID);
      assert.deepEqual(groups, [GROUP_A, GROUP_B]);
      assert.equal(
        requested[0],
        `https://www.arcgis.com/sharing/rest/content/items/${TENNESSEE_GIS_SITE_ID}/data?f=json`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a site item with no catalog", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ error: { message: "Item does not exist" } })) as typeof fetch;
    try {
      await assert.rejects(fetchArcGisHubSiteGroups("missing"), /Item does not exist/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Tennessee GIS plugin", () => {
  it("is a distinct Web Services plugin next to ArcGIS Hub", () => {
    assert.equal(maplibreTennesseeGisPlugin.id, TENNESSEE_GIS_PLUGIN_ID);
    assert.equal(maplibreTennesseeGisPlugin.name, "Tennessee GIS");
    assert.notEqual(maplibreTennesseeGisPlugin, maplibreArcGisHubPlugin);
    assert.equal(maplibreArcGisHubPlugin.id, ARCGIS_HUB_PLUGIN_ID);
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(TENNESSEE_GIS_PLUGIN_ID));
    assert.equal(
      WEB_SERVICE_PLUGIN_IDS.indexOf(TENNESSEE_GIS_PLUGIN_ID),
      WEB_SERVICE_PLUGIN_IDS.indexOf(ARCGIS_HUB_PLUGIN_ID) + 1,
    );
    assert.deepEqual(maplibreTennesseeGisPlugin.engines, [
      "maplibre",
      "cesium",
      "mapbox",
      "arcgis",
    ]);
  });

  it("ships a well-formed fallback catalog", () => {
    assert.ok(TENNESSEE_GIS_CATALOG_GROUPS.length > 0);
    for (const group of TENNESSEE_GIS_CATALOG_GROUPS) assert.match(group, /^[0-9a-f]{32}$/);
  });
});
