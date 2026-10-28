import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { INDIA_GIS_CATALOGS } from "../packages/plugins/src/plugins/india-gis-catalogs";
import {
  DEFAULT_INDIA_GIS_LABELS,
  INDIA_GIS_PLUGIN_ID,
  maplibreIndiaGisPlugin,
} from "../packages/plugins/src/plugins/maplibre-india-gis";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("India GIS catalog", () => {
  it("defines state and national catalog sets with unique ids and valid scopes", () => {
    assert.ok(INDIA_GIS_CATALOGS.length >= 18);
    const setIds = INDIA_GIS_CATALOGS.map((set) => set.id);
    assert.equal(new Set(setIds).size, setIds.length, "Catalog set IDs must be unique");

    const catalogIds = new Set<string>();
    const urls = new Set<string>();
    for (const set of INDIA_GIS_CATALOGS) {
      assert.ok(set.catalogs.length > 0, `${set.name} has at least one portal`);
      for (const catalog of set.catalogs) {
        assert.ok(!catalogIds.has(catalog.id), `Catalog id ${catalog.id} is unique`);
        catalogIds.add(catalog.id);
        assert.ok(!urls.has(catalog.url), `Catalog URL ${catalog.url} is unique`);
        urls.add(catalog.url);
        assert.match(catalog.url, /^https:\/\/[^/]+$/);
        assert.ok(catalog.name.length > 0);
        assert.match(catalog.orgId ?? "", /^[0-9A-Za-z]{16}$/, `${catalog.name} has valid orgId`);
        if (catalog.searchQuery !== undefined) {
          assert.ok(catalog.searchQuery.trim().length > 0);
        }
      }
    }
  });

  it("is registered as an official Web Services plugin", () => {
    assert.equal(INDIA_GIS_PLUGIN_ID, "geolibre-india-gis");
    assert.equal(maplibreIndiaGisPlugin.id, INDIA_GIS_PLUGIN_ID);
    assert.equal(maplibreIndiaGisPlugin.name, "India GIS");
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(INDIA_GIS_PLUGIN_ID));
  });
});

describe("India GIS panel", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("loads the default National portal on open and switches to Delhi GSDL end-to-end", async () => {
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
      return Response.json({
        total: 2,
        start: 1,
        num: 2,
        nextStart: -1,
        results: [
          {
            id: "c711ba97b899443b9b57c152a4f9e391",
            title: "Noida Sector Boundaries",
            owner: "esri_IN_content",
            type: "Feature Service",
            url: "https://livingatlas.esri.in/server/rest/services/Sectors/Noida/MapServer/0",
          },
          {
            id: "2c6f91687f37493ba7411f33ae82b4fe",
            title: "Delhi Assembly Constituency Results",
            owner: "esri_IN_content0",
            type: "Feature Service",
            url: "https://livingatlas.esri.in/server1/rest/services/Elections/Election_Result_of_Delhi_Assembly_Constituency_2025/MapServer/0",
          },
        ],
      });
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
      maplibreIndiaGisPlugin.activate(app);
      await settle();

      // Default catalog set ("national") should be selected and loaded automatically on open.
      const [setSelect, catalogSelect] = Array.from(container.querySelectorAll("select"));
      assert.equal(setSelect.value, "national");
      assert.match(container.textContent ?? "", /Survey of India Composite Boundary/);
      assert.match(container.textContent ?? "", /India 36 States & Union Territories Boundary/);
      assert.match(container.textContent ?? "", new RegExp(DEFAULT_INDIA_GIS_LABELS.showing(4, 4)));

      const pick = (select: HTMLSelectElement, value: string) => {
        const option = Array.from(select.options).find((candidate) => candidate.value === value);
        assert.ok(option, value);
        option.selected = true;
        select.dispatchEvent(new window.Event("change"));
      };

      // Switch to Delhi (NCR) -> Geospatial Delhi Limited (GSDL)
      pick(setSelect, "dl");
      await settle();
      pick(catalogSelect, "dl-geospatial-delhi-limited-gsdl");
      await settle();

      assert.match(container.textContent ?? "", /Delhi State Boundary \(GSDL\)/);
      assert.match(container.textContent ?? "", /Delhi Municipal Corporation \(MCD\) Wards/);
      assert.match(container.textContent ?? "", new RegExp(DEFAULT_INDIA_GIS_LABELS.showing(2, 2)));
    } finally {
      maplibreIndiaGisPlugin.deactivate?.(app);
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
