import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  DEFAULT_US_FEDERAL_GIS_LABELS,
  maplibreUsFederalGisPlugin,
  US_FEDERAL_GIS_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-us-federal-gis";
import { US_LOCAL_GIS_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-us-local-gis";
import { US_FEDERAL_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-federal-gis-catalogs";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("US Federal GIS catalog", () => {
  it("groups agencies by department, alphabetically", () => {
    const ids = US_FEDERAL_GIS_CATALOGS.map((set) => set.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z]+$/);
    const names = US_FEDERAL_GIS_CATALOGS.map((set) => set.name);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("gives every agency a Hub site with an organization fallback, or an organization", () => {
    const catalogIds = new Set<string>();
    const urls = new Set<string>();
    for (const set of US_FEDERAL_GIS_CATALOGS) {
      assert.ok(set.catalogs.length > 0, `${set.name} has an agency`);
      const names = set.catalogs.map((catalog) => catalog.name.toLowerCase());
      assert.deepEqual(names, [...names].sort(), `${set.name} lists its agencies alphabetically`);
      for (const catalog of set.catalogs) {
        assert.match(catalog.id, new RegExp(`^${set.id}-[a-z0-9]+(?:-[a-z0-9]+)*$`));
        assert.ok(!catalogIds.has(catalog.id), `${catalog.id} is unique`);
        catalogIds.add(catalog.id);
        assert.ok(!urls.has(catalog.url), `${catalog.url} is listed once`);
        urls.add(catalog.url);
        assert.match(catalog.url, /^https:\/\/[^/]+$/);
        assert.equal(catalog.socrataDomain, undefined);
        // Never unscoped: a catalog without an organization would widen the
        // search to all of ArcGIS Online once its site lookup failed.
        assert.match(catalog.orgId ?? "", /^[0-9A-Za-z]{16}$/, catalog.name);
        if (catalog.siteId !== undefined) assert.match(catalog.siteId, /^[0-9a-f]{32}$/);
      }
    }
  });

  it("covers the agencies behind the most-requested national layers", () => {
    const names = new Set(
      US_FEDERAL_GIS_CATALOGS.flatMap((set) => set.catalogs.map((catalog) => catalog.name)),
    );
    for (const name of [
      "Census Bureau",
      "NOAA GeoPlatform",
      "U.S. Geological Survey",
      "Fish and Wildlife Service",
      "Natural Resources Conservation Service",
      "FEMA",
    ]) {
      assert.ok(names.has(name), name);
    }
  });

  it("is a Web Services plugin next to US Local GIS", () => {
    assert.equal(maplibreUsFederalGisPlugin.id, US_FEDERAL_GIS_PLUGIN_ID);
    assert.equal(maplibreUsFederalGisPlugin.name, "US Federal GIS");
    assert.equal(
      WEB_SERVICE_PLUGIN_IDS.indexOf(US_FEDERAL_GIS_PLUGIN_ID),
      WEB_SERVICE_PLUGIN_IDS.indexOf(US_LOCAL_GIS_PLUGIN_ID) + 1,
    );
  });
});

describe("US Federal GIS panel", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("searches an organization-only agency by its organization, with map services", async () => {
    const { document, window } = parseHTML("<html><body></body></html>");
    Object.assign(globalThis, { document, window });
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json({ total: 0, start: 1, num: 0, nextStart: -1, results: [] });
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.append(container);
    const app = {
      registerRightPanel: (panel: { render: (el: HTMLElement) => void }) => {
        panel.render(container);
        return () => {};
      },
      openRightPanel: () => {},
      closeRightPanel: () => {},
      getViewBounds: () => null,
    } as unknown as GeoLibreAppAPI;
    try {
      maplibreUsFederalGisPlugin.activate(app);
      assert.match(container.textContent ?? "", /Choose a department, then an agency/);
      const [setSelect, catalogSelect] = Array.from(container.querySelectorAll("select"));
      const pick = (select: HTMLSelectElement, value: string) => {
        const option = Array.from(select.options).find((candidate) => candidate.value === value);
        assert.ok(option, value);
        option.selected = true;
        select.dispatchEvent(new window.Event("change"));
      };
      // Choosing the department lists its first agency, a Hub site.
      pick(setSelect, "doi");
      await settle();
      const afterSite = requests.length;
      pick(catalogSelect, "doi-u-s-geological-survey");
      await settle();

      const usgsRequests = requests.slice(afterSite);
      const searches = usgsRequests.filter((url) => url.pathname.endsWith("/sharing/rest/search"));
      const q = searches.at(-1)?.searchParams.get("q") ?? "";
      assert.match(q, /orgid:v01gqwM5QqNysAAi AND access:public$/);
      assert.match(q, /type:"Map Service"/);
      assert.match(q, /type:"Image Service"/);
      // An organization-only catalog has no Hub site to look up first.
      assert.ok(!usgsRequests.some((url) => url.pathname.includes("/content/items/")));
      assert.match(
        container.textContent ?? "",
        new RegExp(DEFAULT_US_FEDERAL_GIS_LABELS.noResults),
      );
    } finally {
      maplibreUsFederalGisPlugin.deactivate?.(app);
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
