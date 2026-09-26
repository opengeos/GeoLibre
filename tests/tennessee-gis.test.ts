import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  arcGisHubItemPageUrl,
  buildArcGisHubSearchUrl,
  fetchArcGisHubSiteGroups,
} from "../packages/plugins/src/plugins/arcgis-hub-api";
import {
  maplibreArcGisHubPlugin,
  ARCGIS_HUB_PLUGIN_ID,
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
} from "../packages/plugins/src/plugins/maplibre-arcgis-hub";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
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

describe("Hub panel infinite scroll", () => {
  const TOTAL = 45;
  const PAGE = 20;

  /**
   * Open a browse-on-open Hub panel against a fake 45-item catalog.
   *
   * Args:
   *   metrics: Height of one result card and of the visible list; the
   *     list's scroll height grows with its cards like a real one.
   *
   * Returns:
   *   The results list, the search requests made so far, and a teardown.
   */
  const openPanel = (metrics: { rowHeight: number; clientHeight: number }) => {
    const { document, window } = parseHTML("<html><body></body></html>");
    Object.assign(globalThis, { document, window });
    const requests: URL[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      const start = Number(url.searchParams.get("start"));
      const count = Math.max(0, Math.min(PAGE, TOTAL - start + 1));
      const results = Array.from({ length: count }, (_, index) => ({
        id: `item${start + index}`,
        title: `Dataset ${start + index}`,
        owner: "tester",
        type: "Feature Service",
      }));
      const nextStart = start + count > TOTAL ? -1 : start + count;
      return Response.json({ results, total: TOTAL, nextStart });
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.append(container);
    const { plugin } = createArcGisHubPlugin({
      id: "test-hub",
      name: "Test Hub",
      defaultLabels: DEFAULT_ARCGIS_HUB_LABELS,
      resolveGroups: async () => [GROUP_A],
      browseWithoutKeyword: true,
      viewOnlyByDefault: false,
    });
    const app = {
      registerRightPanel: (panel: { render: (el: HTMLElement) => void }) => {
        panel.render(container);
        return () => {};
      },
      openRightPanel: () => {},
      closeRightPanel: () => {},
    } as unknown as GeoLibreAppAPI;
    // The panel renders synchronously and starts its first search right away,
    // so the scroll geometry has to be in place before activate returns.
    const originalAppend = container.append.bind(container);
    container.append = (...nodes: Parameters<HTMLElement["append"]>) => {
      originalAppend(...nodes);
      const results = container.querySelector("button[type=button]")?.previousElementSibling;
      if (results) {
        Object.defineProperty(results, "scrollHeight", {
          get: () => results.querySelectorAll("article").length * metrics.rowHeight,
        });
        Object.defineProperty(results, "clientHeight", { get: () => metrics.clientHeight });
        Object.defineProperty(results, "scrollTop", { value: 0, writable: true });
      }
    };
    plugin.activate(app);
    const results = container.querySelector("button[type=button]")
      ?.previousElementSibling as HTMLElement;
    return {
      results,
      requests,
      cards: () => results.querySelectorAll("article").length,
      // linkedom only dispatches its own Event class, not Node's global one.
      scroll: () => results.dispatchEvent(new window.Event("scroll")),
      close: () => {
        plugin.deactivate?.(app);
        globalThis.fetch = originalFetch;
      },
    };
  };

  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("loads the next page when the list is scrolled near its end", async () => {
    const panel = openPanel({ rowHeight: 100, clientHeight: 400 });
    try {
      await settle();
      assert.equal(panel.requests.length, 1);
      assert.equal(panel.cards(), 20);

      // Still far from the bottom: nothing more is fetched.
      panel.results.scrollTop = 500;
      panel.scroll();
      await settle();
      assert.equal(panel.requests.length, 1);

      panel.results.scrollTop = 1450;
      panel.scroll();
      // A second scroll event while the page is in flight must not double-fetch.
      panel.scroll();
      await settle();
      assert.equal(panel.requests.length, 2);
      assert.equal(panel.requests[1].searchParams.get("start"), "21");
      assert.equal(panel.cards(), 40);
    } finally {
      panel.close();
    }
  });

  it("keeps loading while the results do not fill the list, then stops at the end", async () => {
    const panel = openPanel({ rowHeight: 5, clientHeight: 400 });
    try {
      await settle();
      assert.equal(panel.cards(), TOTAL);
      assert.deepEqual(
        panel.requests.map((url) => url.searchParams.get("start")),
        ["1", "21", "41"],
      );
      panel.scroll();
      await settle();
      assert.equal(panel.requests.length, 3);
    } finally {
      panel.close();
    }
  });
});
