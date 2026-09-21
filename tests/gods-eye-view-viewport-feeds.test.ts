import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchMappedAlprCzml,
  fetchStreetTrafficCzml,
  mappedAlprToCzml,
  streetTrafficToCzml,
  viewportBoundsKey,
  viewportQueryBounds,
} from "../packages/plugins/src/plugins/gods-eye-view-viewport-feeds";

const window = {
  start: new Date("2026-09-20T12:00:00.000Z"),
  stop: new Date("2026-09-20T15:00:00.000Z"),
  current: new Date("2026-09-20T12:00:00.000Z"),
  multiplier: 1,
};

describe("God's Eye View viewport feeds", () => {
  it("snaps small bounds and rejects views that are too wide", () => {
    assert.deepEqual(
      viewportQueryBounds([-122.421, 37.771, -122.389, 37.799], 1.5, 0.05),
      [-122.45, 37.75, -122.35, 37.8],
    );
    assert.equal(viewportQueryBounds([-125, 35, -120, 40], 1.5, 0.05), null);
    assert.equal(
      viewportBoundsKey([-122.42, 37.77, -122.39, 37.79], 1.5, 0.05),
      "-122.4500,37.7500,-122.3500,37.8000",
    );
  });

  it("normalizes only community-mapped ALPR point records", () => {
    const result = mappedAlprToCzml({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "node/1",
          geometry: { type: "Point", coordinates: [-122.4, 37.8] },
          properties: {
            "surveillance:type": "camera; alpr",
            operator: "City",
            "camera:direction": "90",
          },
        },
        {
          type: "Feature",
          id: "node/2",
          geometry: { type: "Point", coordinates: [-122.41, 37.81] },
          properties: { "surveillance:type": "camera" },
        },
      ],
    });
    assert.equal(result.packets.length, 2);
    assert.equal(result.attributes.features.length, 1);
    assert.equal(result.attributes.features[0].properties?.operator, "City");
  });

  it("uses the existing bounded Overpass route for ALPR data", async () => {
    let call: { url: string; init?: RequestInit } | undefined;
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      call = { url: String(input), init };
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 7,
              lat: 37.8,
              lon: -122.4,
              tags: { "surveillance:type": "ALPR", man_made: "surveillance" },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await fetchMappedAlprCzml([-122.45, 37.75, -122.35, 37.85], {
      fetch: mockFetch,
    });

    assert.equal(call?.url, "https://tiles.geolibre.app/overpass");
    assert.match(String(call?.init?.body), /surveillance%3Atype/);
    assert.match(String(call?.init?.body), /%3D%22ALPR%22/);
    assert.equal(result.attributes.features.length, 1);
  });

  it("creates bounded, time-sampled simulated traffic entities", () => {
    const result = streetTrafficToCzml(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "way/9",
            geometry: {
              type: "LineString",
              coordinates: [
                [-122.4, 37.8],
                [-122.399, 37.801],
                [-122.398, 37.8],
              ],
            },
            properties: { highway: "primary", name: "Market Street" },
          },
        ],
      },
      window,
    );
    const position = result.packets[1].position as { epoch: string; cartographicDegrees: number[] };
    assert.equal(result.attributes.features.length, 1);
    assert.equal(position.epoch, window.start.toISOString());
    assert.ok(position.cartographicDegrees.length > 12);
    assert.equal(
      result.packets[1].properties?.mode,
      "Simulated positions on OpenStreetMap road geometry",
    );
  });

  it("does not query Overpass for traffic while zoomed out", async () => {
    let calls = 0;
    const result = await fetchStreetTrafficCzml([-130, 30, -120, 40], window, {
      fetch: (async () => {
        calls += 1;
        return new Response();
      }) as typeof fetch,
    });
    assert.equal(calls, 0);
    assert.equal(result.attributes.features.length, 0);
  });
});
