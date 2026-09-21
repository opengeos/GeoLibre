import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLaunchLibraryUrl,
  buildLaunchLibraryRequestUrls,
  fetchBikeShareCzml,
  fetchSpaceMissionsCzml,
  gbfsSystemToCzml,
  GBFS_SYSTEMS,
  LAUNCH_LIBRARY_EDGE_URL,
  LAUNCH_LIBRARY_DEV_URL,
  launchLibraryToCzml,
} from "../packages/plugins/src/plugins/gods-eye-view-global-feeds";

const launch = {
  id: "mission-1",
  name: "Example Mission",
  net: "2026-09-19T12:00:00Z",
  status: { name: "Launch Successful" },
  launch_service_provider: { name: "Example Space" },
  pad: {
    name: "Pad 1",
    latitude: "28.5",
    longitude: "-80.6",
    location: { name: "Cape Canaveral" },
  },
  mission: { name: "Payload", description: "Earth observation" },
};

describe("God's Eye View global feeds", () => {
  it("builds the bounded Launch Library 2 detailed query", () => {
    const now = new Date("2026-09-20T00:00:00Z");
    const url = new URL(buildLaunchLibraryUrl(now));
    assert.equal(url.searchParams.get("net__gte"), "2026-08-21T00:00:00.000Z");
    assert.equal(url.searchParams.get("net__lte"), "2026-09-20T00:00:00.000Z");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("mode"), "detailed");
  });

  it("uses the local fixed proxy before the edge cache during development", () => {
    const urls = buildLaunchLibraryRequestUrls(true);
    assert.equal(urls[0], LAUNCH_LIBRARY_DEV_URL);
    assert.equal(urls[1], LAUNCH_LIBRARY_EDGE_URL);
  });

  it("uses only the shared edge cache outside the development server", () => {
    assert.deepEqual(buildLaunchLibraryRequestUrls(false), [LAUNCH_LIBRARY_EDGE_URL]);
  });

  it("normalizes launch sites and ignores records without coordinates", () => {
    const result = launchLibraryToCzml({
      results: [
        launch,
        { id: "missing-pad" },
        { id: "null-island", pad: { latitude: null, longitude: null } },
      ],
    });
    assert.equal(result.packets.length, 2);
    assert.equal(result.packets[1].id, "space-mission-mission-1");
    assert.deepEqual(result.packets[1].position, { cartographicDegrees: [-80.6, 28.5, 0] });
    assert.equal(result.attributes.features[0].properties?.provider, "Example Space");
  });

  it("reads space missions through the shared edge cache", async () => {
    const calls: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ results: [launch] }), { status: 200 });
    }) as typeof fetch;
    const result = await fetchSpaceMissionsCzml({
      fetch: mockFetch,
    });
    assert.equal(calls[0], LAUNCH_LIBRARY_EDGE_URL);
    assert.equal(calls.length, 1);
    assert.equal(result.attributes.features.length, 1);
  });

  it("joins GBFS station information and live availability", () => {
    const system = GBFS_SYSTEMS[0];
    const result = gbfsSystemToCzml(
      system,
      {
        data: {
          stations: [{ station_id: "s1", name: "Central", lat: 40.7, lon: -74, capacity: 10 }],
        },
      },
      {
        data: { stations: [{ station_id: "s1", num_bikes_available: 7, num_docks_available: 3 }] },
      },
    );
    assert.equal(result.packets[1].id, `bike-share-${system.id}-s1`);
    assert.equal(result.attributes.features[0].properties?.bikesAvailable, 7);
    assert.deepEqual(
      (result.packets[1].point as { color: { rgba: number[] } }).color.rgba,
      [0, 255, 136, 240],
    );
  });

  it("omits unavailable station values from CZML properties", () => {
    const result = gbfsSystemToCzml(
      GBFS_SYSTEMS[0],
      { data: { stations: [{ station_id: "s1", name: "Central", lat: 40.7, lon: -74 }] } },
      {
        data: {
          stations: [{ station_id: "s1", num_bikes_available: null, num_docks_available: null }],
        },
      },
    );
    assert.deepEqual(result.packets[1].properties, {
      name: "Central",
      city: GBFS_SYSTEMS[0].city,
      provider: GBFS_SYSTEMS[0].provider,
    });
  });

  it("keeps successful GBFS systems when another provider fails", async () => {
    const good = GBFS_SYSTEMS[0];
    const goodUrls = new Set([good.informationUrl, good.statusUrl]);
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (!goodUrls.has(url)) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.includes("station_information")) {
        return new Response(
          JSON.stringify({
            data: { stations: [{ station_id: "s1", name: "Central", lat: 40.7, lon: -74 }] },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ data: { stations: [{ station_id: "s1", num_bikes_available: 2 }] } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await fetchBikeShareCzml({ fetch: mockFetch });
    assert.equal(result.attributes.features.length, 1);
  });
});
