import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubCatalogSet,
} from "../packages/plugins/src/plugins/maplibre-arcgis-hub";
import {
  maplibreUsLocalGisPlugin,
  US_LOCAL_GIS_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-us-local-gis";
import { US_STATE_GIS_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-us-state-gis";
import {
  buildSocrataCatalogUrl,
  featureCollectionBounds,
  isSocrataDomain,
  searchSocrataCatalog,
} from "../packages/plugins/src/plugins/socrata-api";
import { US_LOCAL_GIS_CATALOGS } from "../packages/plugins/src/plugins/us-local-gis-catalogs";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const DOMAIN = "data.example.gov";

/** A Socrata Discovery API catalog entry. */
const entry = (
  id: string,
  columns: string[],
  overrides: { domain?: string; name?: string } = {},
) => ({
  resource: { id, name: overrides.name ?? `Dataset ${id}`, columns_datatype: columns },
  metadata: { domain: overrides.domain ?? DOMAIN },
  classification: { domain_category: "Transportation" },
});

/**
 * Replace fetch for one test.
 *
 * Args:
 *   handler: Answers each request.
 *
 * Returns:
 *   The requested URLs and a restore function.
 */
const stubFetch = (handler: (url: URL) => Response) => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    return handler(url);
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = originalFetch) };
};

describe("US Local GIS catalog", () => {
  it("groups portals by state, alphabetically", () => {
    assert.ok(US_LOCAL_GIS_CATALOGS.length > 30);
    const ids = US_LOCAL_GIS_CATALOGS.map((set) => set.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z]{2}$/);
    const names = US_LOCAL_GIS_CATALOGS.map((set) => set.name);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("gives every portal exactly one kind of search scope", () => {
    const catalogIds = new Set<string>();
    const urls = new Set<string>();
    for (const set of US_LOCAL_GIS_CATALOGS) {
      assert.ok(set.catalogs.length > 0, `${set.name} has a portal`);
      const names = set.catalogs.map((catalog) => catalog.name.toLowerCase());
      assert.deepEqual(names, [...names].sort(), `${set.name} lists its portals alphabetically`);
      for (const catalog of set.catalogs) {
        assert.match(catalog.id, new RegExp(`^${set.id}-[a-z0-9]+(?:-[a-z0-9]+)*$`));
        assert.ok(!catalogIds.has(catalog.id), `${catalog.id} is unique`);
        catalogIds.add(catalog.id);
        assert.ok(!urls.has(catalog.url), `${catalog.url} is listed once`);
        urls.add(catalog.url);
        assert.match(catalog.url, /^https:\/\/[^/]+$/);
        if (catalog.socrataDomain) {
          assert.ok(isSocrataDomain(catalog.socrataDomain), catalog.socrataDomain);
          assert.equal(catalog.url, `https://${catalog.socrataDomain}`);
          assert.equal(catalog.siteId, undefined);
          assert.equal(catalog.orgId, undefined);
        } else {
          assert.match(catalog.siteId ?? "", /^[0-9a-f]{32}$/, catalog.name);
          assert.match(catalog.orgId ?? "", /^[0-9A-Za-z]{16}$/, catalog.name);
        }
      }
    }
  });

  it("covers the largest cities on both platforms", () => {
    const names = new Set(
      US_LOCAL_GIS_CATALOGS.flatMap((set) => set.catalogs.map((catalog) => catalog.name)),
    );
    for (const name of ["New York City", "Chicago", "Houston", "Phoenix", "Philadelphia"]) {
      assert.ok(names.has(name), name);
    }
  });

  it("is a Web Services plugin next to US State GIS", () => {
    assert.equal(maplibreUsLocalGisPlugin.id, US_LOCAL_GIS_PLUGIN_ID);
    assert.equal(maplibreUsLocalGisPlugin.name, "US Local GIS");
    assert.equal(
      WEB_SERVICE_PLUGIN_IDS.indexOf(US_LOCAL_GIS_PLUGIN_ID),
      WEB_SERVICE_PLUGIN_IDS.indexOf(US_STATE_GIS_PLUGIN_ID) + 1,
    );
  });
});

describe("Socrata catalog search", () => {
  it("scopes a search to one portal's own catalog", () => {
    const url = new URL(buildSocrataCatalogUrl(DOMAIN, " bike lanes ", 100));
    assert.equal(url.searchParams.get("search_context"), DOMAIN);
    assert.equal(url.searchParams.get("domains"), DOMAIN);
    assert.equal(url.searchParams.get("only"), "dataset");
    assert.equal(url.searchParams.get("q"), "bike lanes");
    assert.equal(url.searchParams.get("order"), null);
    assert.equal(url.searchParams.get("offset"), "100");
  });

  it("browses by name when there is no keyword", () => {
    const url = new URL(buildSocrataCatalogUrl(DOMAIN, "", 0));
    assert.equal(url.searchParams.get("q"), null);
    assert.equal(url.searchParams.get("order"), "name");
  });

  it("keeps only the portal's own spatial datasets, with URLs on its domain", async () => {
    const stub = stubFetch(() =>
      Response.json({
        resultSetSize: 5,
        results: [
          entry("abcd-1234", ["Text", "MultiPolygon"]),
          entry("efgh-5678", ["Text", "Number"]),
          entry("ijkl-9012", ["Location"], { domain: "evil.example.com" }),
          entry("../../x", ["Point"]),
          entry("MNOP-3456", ["Calendar date", "Point"]),
        ],
      }),
    );
    try {
      const page = await searchSocrataCatalog(DOMAIN, "");
      assert.deepEqual(
        page.results.map((item) => item.id),
        ["abcd-1234", "mnop-3456"],
      );
      const [first] = page.results;
      assert.equal(first.type, "GeoJson");
      assert.equal(first.owner, "Transportation");
      assert.equal(first.dataUrl, `https://${DOMAIN}/resource/abcd-1234.geojson?$limit=50000`);
      assert.equal(first.pageUrl, `https://${DOMAIN}/d/abcd-1234`);
      // The whole catalog was read, so there is nothing more to page.
      assert.equal(page.nextStart, 0);
    } finally {
      stub.restore();
    }
  });

  it("reads further batches until a page is full, then says where to resume", async () => {
    const stub = stubFetch((url) => {
      const offset = Number(url.searchParams.get("offset"));
      // Every batch of 100 holds 10 spatial datasets.
      const results = Array.from({ length: 100 }, (_, index) =>
        entry(`a${String(offset + index).padStart(3, "0")}-0000`, [
          index % 10 === 0 ? "Point" : "Text",
        ]),
      );
      return Response.json({ resultSetSize: 1000, results });
    });
    try {
      const page = await searchSocrataCatalog(DOMAIN, "", { start: 1, num: 20 });
      assert.equal(stub.requests.length, 2);
      assert.equal(page.results.length, 20);
      assert.equal(page.total, 1000);
      assert.equal(page.nextStart, 201);
    } finally {
      stub.restore();
    }
  });

  it("stops scanning a catalog with few spatial datasets", async () => {
    const stub = stubFetch(() =>
      Response.json({
        resultSetSize: 10000,
        results: Array.from({ length: 100 }, (_, index) =>
          entry(`b${String(index).padStart(3, "0")}-0000`, ["Text"]),
        ),
      }),
    );
    try {
      const page = await searchSocrataCatalog(DOMAIN, "");
      assert.equal(stub.requests.length, 5);
      assert.equal(page.results.length, 0);
      assert.equal(page.nextStart, 501);
    } finally {
      stub.restore();
    }
  });

  it("refuses a domain that is not a bare hostname", async () => {
    await assert.rejects(searchSocrataCatalog("evil.example.com/x?", ""), /Invalid Socrata/);
    assert.equal(isSocrataDomain("https://data.example.gov"), false);
    assert.equal(isSocrataDomain(DOMAIN), true);
  });

  it("frames the geometries of a feature collection", () => {
    assert.deepEqual(
      featureCollectionBounds({
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: null as never },
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-87, 42] } },
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-88, 41],
                  [-86.5, 41],
                  [-86.5, 41.5],
                  [-88, 41],
                ],
              ],
            },
          },
        ],
      }),
      [-88, 41, -86.5, 42],
    );
    assert.equal(featureCollectionBounds({ type: "FeatureCollection", features: [] }), null);
  });
});

describe("Socrata portal in the catalog picker", () => {
  const SETS: ArcGisHubCatalogSet[] = [
    {
      id: "il",
      name: "Illinois",
      catalogs: [
        { id: "il-chicago", name: "Chicago", url: `https://${DOMAIN}`, socrataDomain: DOMAIN },
      ],
    },
  ];

  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("searches Socrata, adds a dataset as GeoJSON, and opens its page", async () => {
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
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [-87.6, 41.8] },
        },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [-87.7, 41.9] },
        },
      ],
    };
    const stub = stubFetch((url) =>
      url.hostname === DOMAIN
        ? new Response(JSON.stringify(geojson))
        : Response.json({ resultSetSize: 1, results: [entry("abcd-1234", ["Point"])] }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const { plugin } = createArcGisHubPlugin({
      id: "test-local",
      name: "Test Local",
      defaultLabels: DEFAULT_ARCGIS_HUB_LABELS,
      catalogSets: SETS,
      browseWithoutKeyword: true,
      // On by default: a Socrata portal must still search without an extent.
      viewOnlyByDefault: true,
    });
    const opened: string[] = [];
    const added: Array<[string, unknown, string | undefined]> = [];
    const fitted: unknown[] = [];
    const app = {
      registerRightPanel: (panel: { render: (el: HTMLElement) => void }) => {
        panel.render(container);
        return () => {};
      },
      openRightPanel: () => {},
      closeRightPanel: () => {},
      openExternalUrl: (url: string) => opened.push(url),
      getViewBounds: () => null,
      addGeoJsonLayer: (name: string, data: unknown, source?: string) => {
        added.push([name, data, source]);
        return "layer-1";
      },
      fitBounds: (bounds: unknown) => fitted.push(bounds),
    } as unknown as GeoLibreAppAPI;
    try {
      plugin.activate(app);
      const [setSelect] = Array.from(container.querySelectorAll("select"));
      const option = Array.from(setSelect.options).find((candidate) => candidate.value === "il");
      if (option) option.selected = true;
      setSelect.dispatchEvent(new window.Event("change"));
      await settle();

      const viewOnly = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      assert.equal(viewOnly.disabled, true);
      const searches = stub.requests.filter((url) => url.hostname === "api.us.socrata.com");
      assert.equal(searches.length, 1);
      assert.equal(searches[0].searchParams.get("domains"), DOMAIN);
      assert.match(container.textContent ?? "", /Datasets shown: 1\./);

      const button = (label: string) =>
        Array.from(container.querySelectorAll("button")).find(
          (candidate) => candidate.textContent === label,
        ) as HTMLButtonElement;
      button("Details").click();
      assert.deepEqual(opened, [`https://${DOMAIN}/d/abcd-1234`]);

      button("Add to map").click();
      await settle();
      assert.equal(added.length, 1);
      assert.equal(added[0][0], "Dataset abcd-1234");
      assert.equal(added[0][2], `https://${DOMAIN}/resource/abcd-1234.geojson?$limit=50000`);
      assert.deepEqual(fitted, [[-87.7, 41.8, -87.6, 41.9]]);
      assert.match(container.textContent ?? "", /Added Dataset abcd-1234\./);

      // An export that fills the cap is partial, and the status says so.
      geojson.features = Array.from({ length: 50000 }, () => geojson.features[0]);
      button("Add to map").click();
      await settle();
      assert.match(container.textContent ?? "", /only its first 50,000 features were loaded/);

      // A download is opened, not read, so it always names the cap.
      button("Download").click();
      await settle();
      assert.equal(opened.at(-1), `https://${DOMAIN}/resource/abcd-1234.geojson?$limit=50000`);
      assert.match(container.textContent ?? "", /the export holds at most 50,000 features/);
    } finally {
      plugin.deactivate?.(app);
      stub.restore();
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
