import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOsmDownloadQuery,
  downloadOsmGeoJson,
  overpassJsonToGeoJson,
  type OverpassFetch,
} from "../packages/plugins/src/plugins/osm-downloader-api";
import { OSM_DOWNLOADER_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-osm-downloader";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";

describe("OSM download query", () => {
  it("uses Overpass bbox order and preset tag filters", () => {
    assert.equal(
      buildOsmDownloadQuery([-84.5, 33.6, -84.2, 33.9], { preset: "buildings" }),
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
      buildOsmDownloadQuery([170, -10, 190, 10], { preset: "buildings" }),
      '[out:json][timeout:60];(nwr["building"](-10,170,10,180);' +
        'nwr["building"](-10,-180,10,-170););out geom;',
    );
  });

  it("rejects oversized all-feature downloads", () => {
    assert.throws(
      () => buildOsmDownloadQuery([0, 0, 1, 1], { preset: "all" }),
      /limited to 0.25 square degrees/,
    );
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
    assert.ok(query.includes('nwr["name\\\"] ; node(0,0,9,9)"="A\\\"B C"]'));
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
        { type: "node", id: 1, lon: -84.3, lat: 33.7, tags: { amenity: "cafe" } },
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
});

describe("downloadOsmGeoJson", () => {
  it("posts encoded Overpass QL and converts the response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: OverpassFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ elements: [{ type: "node", id: 7, lon: 1, lat: 2 }] }),
        text: async () => "",
      };
    };
    const result = await downloadOsmGeoJson(
      [0, 0, 3, 4],
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
});
