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
    const itemIds = new Set<string>();
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
        // Every portal is a fixed list of GeoJSON files, never a search that
        // could widen to all of ArcGIS Online.
        assert.equal(catalog.orgId, undefined);
        assert.equal(catalog.siteId, undefined);
        assert.ok(catalog.items && catalog.items.length > 0, `${catalog.name} lists datasets`);
        for (const item of catalog.items) {
          assert.ok(!itemIds.has(item.id), `Item id ${item.id} is unique`);
          itemIds.add(item.id);
          assert.equal(item.type, "GeoJson");
          // raw.githubusercontent.com serves an LFS pointer for geoBoundaries.
          assert.doesNotMatch(item.dataUrl ?? "", /raw\.githubusercontent\.com\/wmgeolab/);
          assert.match(item.dataUrl ?? "", /^https:\/\/.+\.geojson$/);
          assert.match(item.pageUrl ?? "", /^https:\/\//);
          assert.ok(item.owner && item.snippet, `${item.id} names its source`);
          if (item.dataUrl?.includes("datameet/Municipal_Spatial_Data")) {
            assert.match(item.snippet ?? "", /DataMeet/, `${item.id} credits DataMeet`);
          }
        }
      }
    }
  });

  it("cuts each state's districts out of the shared all-India file", () => {
    const districtCards = INDIA_GIS_CATALOGS.flatMap((set) =>
      set.catalogs.flatMap((catalog) => catalog.items ?? []),
    ).filter((item) => item.dataUrl?.endsWith("/district/india_district.geojson"));
    const filtered = districtCards.filter((item) => item.featureFilter);
    // Only the national card loads the whole file.
    assert.equal(districtCards.length - filtered.length, 1);
    for (const item of filtered) {
      assert.equal(item.featureFilter?.property, "NAME_1");
      assert.ok(item.featureFilter?.values.length, `${item.id} names its states`);
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

  it("opens on the national boundaries, switches portals, and adds one state's districts", async () => {
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
    const requests: string[] = [];
    const district = (state: string, x: number) => ({
      type: "Feature",
      properties: { NAME_1: state, NAME_2: `${state} district` },
      geometry: { type: "Point", coordinates: [x, 15] },
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [district("Karnataka", 76), district("Kerala", 76.5), district("Goa", 74)],
        }),
      );
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.append(container);
    const added: Array<[string, { features: unknown[] }]> = [];
    const app = {
      registerRightPanel: (panel: { render: (el: HTMLElement) => void }) => {
        panel.render(container);
        return () => {};
      },
      openRightPanel: () => {},
      closeRightPanel: () => {},
      getViewBounds: () => null,
      addGeoJsonLayer: (name: string, data: unknown) => {
        added.push([name, data as { features: unknown[] }]);
        return "layer-1";
      },
      fitBounds: () => {},
    } as unknown as GeoLibreAppAPI;

    try {
      maplibreIndiaGisPlugin.activate(app);
      await settle();

      // Default catalog set ("national") should be selected and loaded automatically on open.
      const [setSelect, catalogSelect] = Array.from(container.querySelectorAll("select"));
      assert.equal(setSelect.value, "national");
      assert.match(container.textContent ?? "", /India Composite Boundary/);
      assert.match(container.textContent ?? "", new RegExp(DEFAULT_INDIA_GIS_LABELS.showing(1, 1)));

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

      assert.match(container.textContent ?? "", /Delhi State Boundary/);
      assert.match(container.textContent ?? "", /Delhi Municipal Corporation \(MCD\) Wards/);
      assert.match(container.textContent ?? "", new RegExp(DEFAULT_INDIA_GIS_LABELS.showing(2, 2)));
      // Static lists are filtered locally, never searched on ArcGIS Online.
      assert.equal(requests.length, 0);

      // A state's district card loads only that state's districts.
      pick(setSelect, "ka");
      await settle();
      pick(catalogSelect, "ka-karnataka-geographic-information-system-k-gis");
      await settle();
      const addButton = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === DEFAULT_INDIA_GIS_LABELS.add,
      ) as HTMLButtonElement;
      addButton.click();
      await settle();
      assert.equal(requests.length, 1);
      assert.match(requests[0], /\/district\/india_district\.geojson$/);
      assert.equal(added.length, 1);
      assert.equal(added[0][0], "Karnataka District Boundaries");
      assert.deepEqual(added[0][1].features, [district("Karnataka", 76)]);
    } finally {
      maplibreIndiaGisPlugin.deactivate?.(app);
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
