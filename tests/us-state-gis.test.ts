import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  buildArcGisHubSearchUrl,
  fetchArcGisHubSiteGroups,
} from "../packages/plugins/src/plugins/arcgis-hub-api";
import {
  ARCGIS_HUB_PLUGIN_ID,
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubCatalogSet,
} from "../packages/plugins/src/plugins/maplibre-arcgis-hub";
import { TENNESSEE_GIS_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-tennessee-gis";
import {
  maplibreUsStateGisPlugin,
  US_STATE_GIS_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-us-state-gis";
import { US_STATE_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-state-gis-catalogs";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const GROUP_A = "679309d9cf42408d86ab2d2af89c369a";
const GROUP_B = "76d68999556b4897a78370d93da9418b";
const ORG_ID = "YuVBSS7Y1of2Qud1";

describe("Hub catalog scopes", () => {
  it("scopes a search to an ArcGIS organization", () => {
    const q = new URL(buildArcGisHubSearchUrl("roads", { orgId: ORG_ID })).searchParams.get("q");
    assert.match(q ?? "", new RegExp(`\\) AND orgid:${ORG_ID} AND access:public$`));
  });

  it("drops a malformed organization id instead of splicing it into the query", () => {
    const q = new URL(
      buildArcGisHubSearchUrl("roads", { orgId: "x OR owner:someone" }),
    ).searchParams.get("q");
    assert.doesNotMatch(q ?? "", /orgid|owner/);
  });

  it("reads catalog groups from a current (catalogV2) Hub site", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        catalogV2: {
          scopes: {
            item: {
              filters: [
                { predicates: [{ group: { any: [GROUP_A, "bogus", GROUP_B] } }] },
                { predicates: [{ group: [GROUP_A] }, { group: GROUP_B }, { type: "x" }] },
              ],
            },
          },
        },
      })) as typeof fetch;
    try {
      assert.deepEqual(await fetchArcGisHubSiteGroups("site"), [GROUP_A, GROUP_B]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the legacy catalog groups when catalogV2 has none", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        catalog: { groups: [GROUP_B] },
        catalogV2: { scopes: { item: { filters: [] } } },
      })) as typeof fetch;
    try {
      assert.deepEqual(await fetchArcGisHubSiteGroups("site"), [GROUP_B]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("US State GIS catalog", () => {
  it("covers every state and DC once, alphabetically", () => {
    assert.equal(US_STATE_GIS_CATALOGS.length, 51);
    const ids = US_STATE_GIS_CATALOGS.map((set) => set.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z]{2}$/);
    const names = US_STATE_GIS_CATALOGS.map((set) => set.name);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("gives every portal a scope the search can use", () => {
    const catalogIds = new Set<string>();
    for (const set of US_STATE_GIS_CATALOGS) {
      assert.ok(set.catalogs.length > 0, `${set.name} has a portal`);
      for (const catalog of set.catalogs) {
        assert.ok(!catalogIds.has(catalog.id), `${catalog.id} is unique`);
        catalogIds.add(catalog.id);
        assert.match(catalog.url, /^https:\/\/[^/]+$/);
        if (catalog.siteId) assert.match(catalog.siteId, /^[0-9a-f]{32}$/);
        // Every portal carries its organization, the fallback when a site
        // catalog cannot be read.
        assert.match(catalog.orgId ?? "", /^[0-9A-Za-z]{16}$/, catalog.name);
      }
    }
  });

  it("is a Web Services plugin next to Tennessee GIS", () => {
    assert.equal(maplibreUsStateGisPlugin.id, US_STATE_GIS_PLUGIN_ID);
    assert.equal(maplibreUsStateGisPlugin.name, "US State GIS");
    assert.equal(
      WEB_SERVICE_PLUGIN_IDS.indexOf(US_STATE_GIS_PLUGIN_ID),
      WEB_SERVICE_PLUGIN_IDS.indexOf(TENNESSEE_GIS_PLUGIN_ID) + 1,
    );
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(ARCGIS_HUB_PLUGIN_ID));
  });
});

describe("Hub catalog picker", () => {
  const SITE_ID = "4649b629c9b647a8822b052cadc89072";
  const SETS: ArcGisHubCatalogSet[] = [
    {
      id: "aa",
      name: "Alpha",
      catalogs: [{ id: "aa-1", name: "Alpha Hub", url: "https://alpha.example", siteId: SITE_ID }],
    },
    {
      id: "bb",
      name: "Beta",
      catalogs: [
        { id: "bb-1", name: "Beta Org", url: "https://beta.example", orgId: ORG_ID },
        {
          id: "bb-2",
          name: "Beta Hub",
          url: "https://beta-hub.example",
          siteId: SITE_ID,
          orgId: ORG_ID,
        },
      ],
    },
  ];

  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /**
   * Open a picker panel against a fake portal.
   *
   * Args:
   *   siteLookup: Answers the Hub site item request.
   *   storage: Backs the fake localStorage; a fresh one per call by default,
   *     `null` for storage that throws (e.g. blocked in a private window).
   *
   * Returns:
   *   The panel's selects, the requests made, what was opened, and a teardown.
   */
  const openPanel = (
    siteLookup: () => Response,
    storage: Map<string, string> | null = new Map(),
  ) => {
    const { document, window } = parseHTML("<html><body></body></html>");
    Object.assign(globalThis, { document, window });
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const blocked = () => {
      throw new Error("SecurityError");
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (storage ? (storage.get(key) ?? null) : blocked()),
        setItem: (key: string, value: string) => (storage ? storage.set(key, value) : blocked()),
      },
    });
    const requests: URL[] = [];
    const opened: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/data")) return siteLookup();
      return Response.json({
        results: [{ id: "item1", title: "Roads", owner: "state", type: "Feature Service" }],
        total: 1,
        nextStart: -1,
      });
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.append(container);
    const { plugin } = createArcGisHubPlugin({
      id: "test-picker",
      name: "Test Picker",
      defaultLabels: {
        ...DEFAULT_ARCGIS_HUB_LABELS,
        chooseCatalogSet: "Pick one.",
        openPortal: "Open portal",
      },
      catalogSets: SETS,
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
      openExternalUrl: (url: string) => opened.push(url),
    } as unknown as GeoLibreAppAPI;
    plugin.activate(app);
    const [setSelect, catalogSelect] = Array.from(container.querySelectorAll("select"));
    const choose = (select: HTMLSelectElement, value: string) => {
      // linkedom's select.value is read-only, so pick the option instead. Only
      // ever set `selected = true`: linkedom's `false` clears the chosen option.
      const option = Array.from(select.options).find((candidate) => candidate.value === value);
      if (option) option.selected = true;
      select.dispatchEvent(new window.Event("change"));
    };
    const searches = () => requests.filter((url) => url.pathname.endsWith("/search"));
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === label,
      ) as HTMLButtonElement;
    return {
      container,
      setSelect,
      catalogSelect,
      choose,
      requests,
      searches,
      opened,
      button,
      close: () => {
        plugin.deactivate?.(app);
        globalThis.fetch = originalFetch;
        if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
        else delete (globalThis as { localStorage?: unknown }).localStorage;
      },
    };
  };

  it("waits for a state before searching anything", async () => {
    const panel = openPanel(() => Response.json({ catalog: { groups: [GROUP_A] } }));
    try {
      await settle();
      assert.equal(panel.requests.length, 0);
      assert.match(panel.container.textContent ?? "", /Pick one\./);
    } finally {
      panel.close();
    }
  });

  it("searches the chosen site's groups and opens its own dataset pages", async () => {
    const panel = openPanel(() => Response.json({ catalog: { groups: [GROUP_A] } }));
    try {
      panel.choose(panel.setSelect, "aa");
      await settle();
      assert.equal(panel.catalogSelect.hidden, true);
      const q = panel.searches()[0].searchParams.get("q") ?? "";
      assert.match(q, new RegExp(`group:${GROUP_A}`));
      assert.doesNotMatch(q, /orgid/);
      panel.button("Details").click();
      assert.deepEqual(panel.opened, ["https://alpha.example/datasets/item1/about"]);
    } finally {
      panel.close();
    }
  });

  it("searches an organization and switches between a state's portals", async () => {
    const panel = openPanel(() => Response.json({ catalog: { groups: [GROUP_B] } }));
    try {
      panel.choose(panel.setSelect, "bb");
      await settle();
      assert.equal(panel.catalogSelect.hidden, false);
      assert.match(panel.searches()[0].searchParams.get("q") ?? "", new RegExp(`orgid:${ORG_ID}`));
      // An organization-scoped item may not be on any site: use the global Hub.
      panel.button("Details").click();
      assert.equal(panel.opened.at(-1), "https://hub.arcgis.com/datasets/item1/about");

      panel.choose(panel.catalogSelect, "bb-2");
      await settle();
      assert.match(panel.searches()[1].searchParams.get("q") ?? "", new RegExp(`group:${GROUP_B}`));
      panel.button("Open portal").click();
      assert.equal(panel.opened.at(-1), "https://beta-hub.example");
    } finally {
      panel.close();
    }
  });

  it("falls back to the organization when the site catalog cannot be read", async () => {
    const warn = console.warn;
    console.warn = () => {};
    const panel = openPanel(() => Response.json({ error: { message: "Item does not exist" } }));
    try {
      panel.choose(panel.setSelect, "bb");
      panel.choose(panel.catalogSelect, "bb-2");
      await settle();
      const q = panel.searches().at(-1)?.searchParams.get("q") ?? "";
      assert.match(q, new RegExp(`orgid:${ORG_ID}`));
      assert.doesNotMatch(q, /group:/);
    } finally {
      console.warn = warn;
      panel.close();
    }
  });

  it("never searches a site with no groups and no organization", async () => {
    const error = console.error;
    console.error = () => {};
    const panel = openPanel(() => Response.json({ catalog: { groups: [] } }));
    try {
      panel.choose(panel.setSelect, "aa");
      await settle();
      assert.equal(panel.searches().length, 0);
      assert.match(panel.container.textContent ?? "", /Could not search/);
    } finally {
      console.error = error;
      panel.close();
    }
  });

  it("remembers the chosen state and portal for the next session", async () => {
    const storage = new Map<string, string>();
    const site = () => Response.json({ catalog: { groups: [GROUP_B] } });
    const first = openPanel(site, storage);
    try {
      first.choose(first.setSelect, "bb");
      first.choose(first.catalogSelect, "bb-2");
      await settle();
    } finally {
      first.close();
    }
    // A fresh plugin instance stands in for a reload of the app.
    const second = openPanel(site, storage);
    try {
      await settle();
      assert.equal(second.setSelect.value, "bb");
      assert.equal(second.catalogSelect.value, "bb-2");
      // The remembered state is listed without picking it again.
      assert.equal(second.searches().length, 1);
      assert.match(
        second.searches()[0].searchParams.get("q") ?? "",
        new RegExp(`group:${GROUP_B}`),
      );
    } finally {
      second.close();
    }
  });

  it("ignores a remembered state that no longer exists", async () => {
    const storage = new Map([
      ["geolibre:test-picker:catalog", JSON.stringify({ set: "zz", catalogs: { bb: "bb-9" } })],
    ]);
    const panel = openPanel(() => Response.json({ catalog: { groups: [GROUP_A] } }), storage);
    try {
      await settle();
      assert.equal(panel.requests.length, 0);
      panel.choose(panel.setSelect, "bb");
      await settle();
      // The stale portal id falls back to the state's first portal.
      assert.equal(panel.catalogSelect.value, "bb-1");
    } finally {
      panel.close();
    }
  });

  it("still works when storage is blocked", async () => {
    const panel = openPanel(() => Response.json({ catalog: { groups: [GROUP_A] } }), null);
    try {
      panel.choose(panel.setSelect, "aa");
      await settle();
      assert.equal(panel.searches().length, 1);
    } finally {
      panel.close();
    }
  });
});
