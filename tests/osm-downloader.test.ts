import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { parseHTML } from "linkedom";
import {
  buildOsmDownloadQuery,
  canDownloadOsmBounds,
  defaultOverpassEndpoint,
  downloadOsmGeoJson,
  MAX_OSM_MAP_API_AREA_SQUARE_DEGREES,
  OSM_MAP_API_ENDPOINT,
  OVERPASS_DEFAULT_ENDPOINT,
  OVERPASS_DEV_ENDPOINT,
  overpassJsonToGeoJson,
  osmApiJsonToGeoJson,
  osmDownloadAreaLimit,
  osmDownloadBoundsArea,
  type OverpassFetch,
} from "../packages/plugins/src/plugins/osm-downloader-api";
import {
  maplibreOsmDownloaderPlugin,
  OSM_DOWNLOADER_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-osm-downloader";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import type { GeoLibreAppAPI, GeoLibreRightPanelRegistration } from "../packages/plugins/src/types";

describe("OSM download query", () => {
  it("reports whether the current bounds are eligible before downloading", () => {
    assert.equal(osmDownloadAreaLimit("roads"), 4);
    assert.equal(osmDownloadAreaLimit("all"), 0.25);
    assert.equal(osmDownloadBoundsArea([0, 0, 2, 2]), 4);
    assert.equal(canDownloadOsmBounds([0, 0, 2, 2], "roads"), true);
    assert.equal(canDownloadOsmBounds([0, 0, 2.01, 2], "roads"), false);
    assert.equal(canDownloadOsmBounds([0, 0, 0.5, 0.5], "all"), true);
    assert.equal(canDownloadOsmBounds([0, 0, 0.51, 0.5], "all"), false);
    assert.equal(canDownloadOsmBounds([2, 0, 1, 1], "roads"), false);
  });

  it("uses Overpass bbox order and preset tag filters", () => {
    assert.equal(
      buildOsmDownloadQuery([-84.5, 33.6, -84.2, 33.9], {
        preset: "buildings",
      }),
      '[out:json][timeout:60];nwr["building"](33.6,-84.5,33.9,-84.2);out geom;',
    );
  });

  it("limits the all-features preset to tagged elements", () => {
    assert.match(
      buildOsmDownloadQuery([0, 1, 0.1, 1.1], { preset: "all" }),
      /nwr\[~"\."~"\."\]\(1,0,1\.1,0\.1\)/,
    );
  });

  it("splits antimeridian-crossing view bounds into two selectors", () => {
    assert.equal(
      buildOsmDownloadQuery([179.9, -0.1, 180.1, 0.1], { preset: "buildings" }),
      '[out:json][timeout:60];(nwr["building"](-0.1,179.9,0.1,180);' +
        'nwr["building"](-0.1,-180,0.1,-179.9););out geom;',
    );
  });

  it("omits a zero-width antimeridian half", () => {
    assert.equal(
      buildOsmDownloadQuery([180, -0.1, 180.1, 0.1], { preset: "buildings" }),
      '[out:json][timeout:60];nwr["building"](-0.1,-180,0.1,-179.9);out geom;',
    );
  });

  it("renders tiny coordinates without exponent notation", () => {
    const query = buildOsmDownloadQuery([0.0000005, 0, 0.0000015, 0.001], {
      preset: "buildings",
    });
    assert.match(query, /\(0,0\.0000005,0\.001,0\.0000015\)/);
    assert.doesNotMatch(query, /e-/i);
  });

  it("preserves distinct positive and negative coordinates near zero", () => {
    assert.match(
      buildOsmDownloadQuery([1e-16, 0, 2e-16, 1], { preset: "buildings" }),
      /\(0,0\.0000000000000001,1,0\.0000000000000002\)/,
    );
    assert.match(
      buildOsmDownloadQuery([-2e-16, 0, -1e-16, 1], { preset: "buildings" }),
      /\(0,-0\.0000000000000002,1,-0\.0000000000000001\)/,
    );
  });

  it("rejects oversized all-feature downloads", () => {
    assert.throws(
      () => buildOsmDownloadQuery([0, 0, 1, 1], { preset: "all" }),
      /limited to 0.25 square degrees/,
    );
  });

  it("rejects oversized filtered downloads and invalid manual longitudes", () => {
    assert.throws(
      () => buildOsmDownloadQuery([0, 0, 3, 2], { preset: "roads" }),
      /limited to 4 square degrees/,
    );
    assert.throws(() => buildOsmDownloadQuery([200, 0, 210, 1], { preset: "roads" }));
  });

  it("supports key-only and key/value custom filters without query injection", () => {
    assert.match(
      buildOsmDownloadQuery([0, 1, 2, 3], { preset: "custom", key: "shop" }),
      /nwr\["shop"\]/,
    );
    const query = buildOsmDownloadQuery([0, 1, 2, 3], {
      preset: "custom",
      key: 'name"] ; node(0,0,9,9)',
      value: 'A"B\nC',
    });
    assert.ok(query.includes('nwr["name\\"] ; node(0,0,9,9)"="A\\"B C"]'));
  });

  it("rejects custom tags too long for a useful OSM value", () => {
    assert.throws(
      () =>
        buildOsmDownloadQuery([0, 1, 2, 3], {
          preset: "custom",
          key: "x".repeat(256),
        }),
      /limited to 255 characters/,
    );
  });

  it("rejects invalid bounds and missing custom keys", () => {
    assert.throws(() => buildOsmDownloadQuery([2, 1, 0, 3], { preset: "roads" }));
    assert.throws(() => buildOsmDownloadQuery([0, 1, 2, 3], { preset: "custom" }));
  });
});

describe("Overpass JSON conversion", () => {
  it("converts tagged nodes, line ways, and area ways", () => {
    const result = overpassJsonToGeoJson({
      elements: [
        {
          type: "node",
          id: 1,
          lon: -84.3,
          lat: 33.7,
          tags: { amenity: "cafe" },
        },
        {
          type: "way",
          id: 2,
          tags: { highway: "residential" },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 0 },
            { lon: 0, lat: 0 },
          ],
        },
        {
          type: "way",
          id: 3,
          tags: { building: "yes", name: "Library" },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 0 },
            { lon: 1, lat: 1 },
            { lon: 0, lat: 0 },
          ],
        },
      ],
    });
    assert.deepEqual(
      result.features.map((feature) => feature.geometry.type),
      ["Point", "LineString", "Polygon"],
    );
    assert.equal(result.features[0].id, "node/1");
    assert.equal(result.features[0].properties?.osm_type, "node");
    assert.equal(result.features[2].properties?.name, "Library");
  });

  it("joins split multipolygon members and assigns inner rings", () => {
    const result = overpassJsonToGeoJson({
      elements: [
        {
          type: "relation",
          id: 42,
          tags: { type: "multipolygon", landuse: "forest" },
          members: [
            {
              type: "way",
              ref: 1,
              role: "outer",
              geometry: [
                { lon: 0, lat: 0 },
                { lon: 2, lat: 0 },
                { lon: 2, lat: 2 },
              ],
            },
            {
              type: "way",
              ref: 2,
              role: "outer",
              geometry: [
                { lon: 0, lat: 0 },
                { lon: 0, lat: 2 },
                { lon: 2, lat: 2 },
              ],
            },
            {
              type: "way",
              ref: 3,
              role: "inner",
              geometry: [
                { lon: 0.5, lat: 0.5 },
                { lon: 1, lat: 0.5 },
                { lon: 1, lat: 1 },
                { lon: 0.5, lat: 0.5 },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(result.features[0].geometry.type, "MultiPolygon");
    if (result.features[0].geometry.type !== "MultiPolygon") return;
    assert.equal(result.features[0].geometry.coordinates.length, 1);
    assert.equal(result.features[0].geometry.coordinates[0].length, 2);
  });

  it("drops a way rather than joining across missing geometry", () => {
    const result = overpassJsonToGeoJson({
      elements: [
        {
          type: "way",
          id: 9,
          tags: { highway: "residential" },
          geometry: [{ lon: 0, lat: 0 }, null, { lon: 1, lat: 1 }],
        },
      ],
    });
    assert.equal(result.features.length, 0);
  });

  it("drops coordinates outside valid WGS84 ranges at every conversion path", () => {
    const result = overpassJsonToGeoJson({
      elements: [
        { type: "node", id: 1, lon: 500, lat: 20, tags: { amenity: "cafe" } },
        {
          type: "way",
          id: 2,
          tags: { highway: "road" },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 100 },
          ],
        },
        {
          type: "relation",
          id: 3,
          tags: { type: "route" },
          members: [{ type: "node", ref: 4, lon: -181, lat: 0 }],
        },
      ],
    });
    assert.equal(result.features.length, 0);
  });

  it("drops an incomplete multipolygon instead of mixing inner and outer lines", () => {
    const result = overpassJsonToGeoJson({
      elements: [
        {
          type: "relation",
          id: 10,
          tags: { type: "multipolygon", landuse: "forest" },
          members: [
            {
              type: "way",
              ref: 1,
              role: "outer",
              geometry: [
                { lon: 0, lat: 0 },
                { lon: 1, lat: 0 },
              ],
            },
            {
              type: "way",
              ref: 2,
              role: "inner",
              geometry: [
                { lon: 0.2, lat: 0.2 },
                { lon: 0.4, lat: 0.2 },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(result.features.length, 0);
  });
});

describe("OSM map API fallback conversion", () => {
  it("reconstructs way geometry and applies the selected tag filter", () => {
    const result = osmApiJsonToGeoJson(
      {
        elements: [
          { type: "node", id: 1, lon: 1, lat: 2 },
          { type: "node", id: 2, lon: 2, lat: 2 },
          { type: "node", id: 3, lon: 2, lat: 3 },
          { type: "node", id: 4, lon: 1, lat: 2 },
          {
            type: "way",
            id: 10,
            nodes: [1, 2, 3, 4],
            tags: { building: "yes" },
          },
          { type: "way", id: 11, nodes: [1, 2], tags: { highway: "service" } },
        ],
      },
      { preset: "buildings" },
    );

    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].id, "way/10");
    assert.equal(result.features[0].geometry.type, "Polygon");
  });
});

describe("downloadOsmGeoJson", () => {
  it("uses the same-origin relay in Vite development", () => {
    assert.equal(defaultOverpassEndpoint(true), OVERPASS_DEV_ENDPOINT);
    assert.equal(defaultOverpassEndpoint(false), OVERPASS_DEFAULT_ENDPOINT);
  });

  it("uses GeoLibre's CORS-enabled Overpass relay by default", async () => {
    const calls: string[] = [];
    const fetchImpl: OverpassFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ elements: [] }),
        text: async () => "",
      };
    };
    await downloadOsmGeoJson([0, 0, 1, 1], { preset: "roads" }, { fetchImpl });
    assert.equal(OVERPASS_DEFAULT_ENDPOINT, "https://tiles.geolibre.app/overpass");
    assert.deepEqual(calls, [OVERPASS_DEFAULT_ENDPOINT]);
  });

  it("posts encoded Overpass QL and converts the response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: OverpassFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          elements: [{ type: "node", id: 7, lon: 1, lat: 2 }],
        }),
        text: async () => "",
      };
    };
    const result = await downloadOsmGeoJson(
      [0, 0, 1, 1],
      { preset: "amenities" },
      {
        endpoint: "https://overpass.example/api",
        fetchImpl,
      },
    );
    assert.equal(calls[0].url, "https://overpass.example/api");
    assert.equal(calls[0].init.method, "POST");
    assert.match(String(calls[0].init.body), /^data=%5Bout%3Ajson/);
    assert.equal(result.features.length, 1);
  });

  it("surfaces Overpass HTTP errors", async () => {
    const fetchImpl: OverpassFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "<p>Please retry later</p>",
    });
    await assert.rejects(
      () => downloadOsmGeoJson([0, 0, 1, 1], { preset: "roads" }, { fetchImpl }),
      /429.*Please retry later/,
    );
  });

  it("falls back to the OSM map API for a small extent when Overpass is busy", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchImpl: OverpassFetch = async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
          text: async () => "Bad Gateway",
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          elements: [
            { type: "node", id: 1, lon: 0, lat: 0 },
            { type: "node", id: 2, lon: 0.1, lat: 0 },
            { type: "way", id: 3, nodes: [1, 2], tags: { highway: "service" } },
          ],
        }),
      };
    };

    const result = await downloadOsmGeoJson([0, 0, 0.1, 0.1], { preset: "roads" }, { fetchImpl });

    assert.equal(result.features.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "GET");
    assert.equal(
      new URL(calls[1].url).origin + new URL(calls[1].url).pathname,
      OSM_MAP_API_ENDPOINT,
    );
  });

  it("does not use the map API fallback above its safe area limit", async () => {
    let calls = 0;
    const fetchImpl: OverpassFetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 502,
        json: async () => ({}),
        text: async () => "Bad Gateway",
      };
    };

    await assert.rejects(
      () =>
        downloadOsmGeoJson(
          [0, 0, MAX_OSM_MAP_API_AREA_SQUARE_DEGREES + 0.01, 1],
          { preset: "roads" },
          { fetchImpl },
        ),
      /502/,
    );
    assert.equal(calls, 1);
  });

  it("rejects partial results carrying an Overpass remark", async () => {
    const fetchImpl: OverpassFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        remark: "runtime error: Query timed out",
        elements: [{ type: "node", id: 7, lon: 1, lat: 2 }],
      }),
      text: async () => "",
    });
    await assert.rejects(
      () => downloadOsmGeoJson([0, 0, 1, 1], { preset: "roads" }, { fetchImpl }),
      /Query timed out/,
    );
  });

  it("aborts a stalled request after the client timeout", async () => {
    const fetchImpl: OverpassFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    await assert.rejects(
      () => downloadOsmGeoJson([0, 0, 1, 1], { preset: "roads" }, { fetchImpl, timeoutMs: 5 }),
      /timed out/,
    );
  });
});

describe("OSM downloader registration", () => {
  it("appears in the Web Services plugin group", () => {
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(OSM_DOWNLOADER_PLUGIN_ID));
  });

  it("previews once, then reuses the result for adding and GeoJSON export", async () => {
    const dom = parseHTML("<html><body></body></html>");
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      HTMLElement: globalThis.HTMLElement,
      Event: globalThis.Event,
      Option: globalThis.Option,
      fetch: globalThis.fetch,
    };
    const selectProto = (dom.window as unknown as { HTMLSelectElement: { prototype: object } })
      .HTMLSelectElement.prototype;
    Object.defineProperty(selectProto, "value", {
      configurable: true,
      get(this: Element) {
        return (
          this.getAttribute("data-test-value") ??
          this.querySelector("option")?.getAttribute("value") ??
          ""
        );
      },
      set(this: Element, value: unknown) {
        this.setAttribute("data-test-value", String(value));
      },
    });
    class TestOption {
      constructor(text = "", value = "") {
        const option = dom.document.createElement("option");
        option.textContent = text;
        option.setAttribute("value", value);
        return option;
      }
    }

    // `as`, not an annotation: the fake assigns this in a callback TypeScript cannot follow.
    let panel = null as GeoLibreRightPanelRegistration | null;
    let fetchCount = 0;
    const added: Array<{ id: string; name: string; data: FeatureCollection }> = [];
    const removed: string[] = [];
    const exported: Array<{ name: string; contents: string }> = [];
    const app = {
      getMap: () => null,
      getViewBounds: () => [-9.145, 38.71, -9.14, 38.715] as [number, number, number, number],
      registerRightPanel: (registration: GeoLibreRightPanelRegistration) => {
        panel = registration;
        return () => {};
      },
      openRightPanel: () => {},
      closeRightPanel: () => {},
      addGeoJsonLayer: (name: string, data: FeatureCollection) => {
        const id = `layer-${added.length + 1}`;
        added.push({ id, name, data });
        return id;
      },
      removeLayer: (id: string) => removed.push(id),
      exportTextFile: (name: string, contents: string) => {
        exported.push({ name, contents });
      },
    } as unknown as GeoLibreAppAPI;

    Object.assign(globalThis, {
      document: dom.document,
      window: dom.window,
      HTMLElement: dom.window.HTMLElement,
      Event: dom.window.Event,
      Option: TestOption,
      fetch: async () => {
        fetchCount += 1;
        return new Response(
          JSON.stringify({
            elements: [
              {
                type: "way",
                id: 7,
                tags: { building: "yes" },
                geometry: [
                  { lon: -9.144, lat: 38.711 },
                  { lon: -9.143, lat: 38.711 },
                  { lon: -9.143, lat: 38.712 },
                  { lon: -9.144, lat: 38.711 },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      maplibreOsmDownloaderPlugin.activate(app);
      assert.ok(panel);
      const container = dom.document.createElement("div");
      panel.render(container);
      const buttons = Array.from(container.querySelectorAll("button"));
      const preview = buttons.find((button) => button.textContent === "Preview OSM data");
      const add = buttons.find((button) => button.textContent === "Add to map");
      const save = buttons.find((button) => button.textContent === "Save GeoJSON");
      assert.ok(preview);
      assert.ok(add);
      assert.ok(save);

      preview.dispatchEvent(new dom.window.Event("click"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(fetchCount, 1);
      assert.equal(added.length, 1);
      assert.equal(added[0].name, "Preview — OSM buildings");
      assert.equal(add.disabled, false);
      assert.equal(save.disabled, false);
      assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /1 features/);

      add.dispatchEvent(new dom.window.Event("click"));
      assert.deepEqual(removed, ["layer-1"]);
      assert.equal(added.length, 2);
      assert.equal(added[1].name, "OSM buildings");
      assert.equal(fetchCount, 1);

      save.dispatchEvent(new dom.window.Event("click"));
      assert.equal(exported.length, 1);
      assert.match(exported[0].name, /^osm-buildings-\d{4}-\d{2}-\d{2}\.geojson$/);
      assert.equal(JSON.parse(exported[0].contents).features.length, 1);
      assert.equal(fetchCount, 1);
    } finally {
      maplibreOsmDownloaderPlugin.deactivate(app);
      Object.assign(globalThis, previous);
    }
  });
});
