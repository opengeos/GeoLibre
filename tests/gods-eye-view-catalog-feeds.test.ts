import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  DATACENTERS_URL,
  fetchDatacentersCzml,
  infrastructureQueryBounds,
  osmInfrastructureToCzml,
  radioBrowserStationsToCzml,
  submarineCablesToCzml,
} from "../packages/plugins/src/plugins/gods-eye-view-catalog-feeds";

describe("God's Eye View catalog feeds", () => {
  it("normalizes geolocated Radio Browser stations and rejects invalid coordinates", () => {
    const result = radioBrowserStationsToCzml([
      {
        stationuuid: "station-1",
        name: "World Service",
        url_resolved: "https://radio.example/live.mp3",
        country: "United Kingdom",
        codec: "MP3",
        bitrate: 128,
        geo_long: -0.12,
        geo_lat: 51.5,
      },
      { stationuuid: "bad", name: "Nowhere", geo_long: 999, geo_lat: 0 },
    ]);
    assert.equal(result.packets.length, 2);
    assert.equal(result.packets[1].id, "radio-station-1");
    assert.deepEqual(result.packets[1].position, {
      cartographicDegrees: [-0.12, 51.5, 0],
    });
    assert.equal(result.attributes.features.length, 1);
    assert.equal(
      result.attributes.features[0].properties?.streamUrl,
      "https://radio.example/live.mp3",
    );
  });

  it("turns GeoJSONL polygons into lightweight datacenter points", async () => {
    const mockFetch = (async (input: string | URL | Request) => {
      assert.equal(String(input), DATACENTERS_URL);
      return new Response(
        `${JSON.stringify({
          type: "Feature",
          id: 7,
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [179.8, 10],
                [-179.8, 10],
                [-179.8, 10.2],
                [179.8, 10.2],
                [179.8, 10],
              ],
            ],
          },
          properties: {
            tags: {
              name: "Date Line DC",
              operator: "Example",
              empty: null,
              invalid: Infinity,
            },
          },
        })}\n`,
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await fetchDatacentersCzml({ fetch: mockFetch });
    assert.equal(result.packets.length, 2);
    const position = result.packets[1].position as {
      cartographicDegrees: number[];
    };
    assert.ok(Math.abs(Math.abs(position.cartographicDegrees[0]) - 180) < 0.01);
    assert.equal(result.packets[1].name, "Date Line DC");
    assert.equal(result.attributes.features[0].properties?.operator, "Example");
    assert.ok(!("empty" in (result.packets[1].properties as Record<string, unknown>)));
    assert.ok(!("invalid" in (result.packets[1].properties as Record<string, unknown>)));
  });

  it("preserves every submarine-cable line and provider color", () => {
    const input: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "cable-a", name: "Cable A", color: "#123456" },
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [1, 2],
                [3, 4],
              ],
              [
                [5, 6],
                [7, 8],
              ],
            ],
          },
        },
      ],
    };
    const result = submarineCablesToCzml(input);
    assert.equal(result.packets.length, 3);
    assert.equal(result.attributes.features.length, 2);
    assert.deepEqual(
      (
        (
          (result.packets[1].polyline as Record<string, unknown>).material as Record<
            string,
            unknown
          >
        ).solidColor as { color: { rgba: number[] } }
      ).color.rgba,
      [18, 52, 86, 215],
    );
  });

  it("bounds Overpass infrastructure searches around the current view", () => {
    assert.deepEqual(
      infrastructureQueryBounds([-122.5, 37.7, -122.4, 37.8]),
      [-122.5, 37.7, -122.4, 37.8],
    );
    const global = infrastructureQueryBounds([-180, -90, 180, 90]);
    assert.ok((global[2] - global[0]) * (global[3] - global[1]) <= 4);
    const crossing = infrastructureQueryBounds([-181, 10, -178, 13]);
    assert.ok(crossing[0] >= -180 && crossing[0] <= 180);
    assert.ok(crossing[2] > 180, "the antimeridian crossing stays unwrapped");
  });

  it("renders point and line OSM infrastructure as CZML", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "node/1",
          geometry: { type: "Point", coordinates: [10, 20] },
          properties: { man_made: "communications_tower" },
        },
        {
          type: "Feature",
          id: "way/2",
          geometry: {
            type: "LineString",
            coordinates: [
              [10, 20],
              [11, 21],
            ],
          },
          properties: { name: "Pipeline", man_made: "pipeline" },
        },
        {
          type: "Feature",
          id: "node/bad",
          geometry: { type: "Point", coordinates: [999, 20] },
          properties: { name: "Invalid tower" },
        },
      ],
    };
    const result = osmInfrastructureToCzml(collection);
    assert.equal(result.packets.length, 3);
    assert.deepEqual(result.packets[1].position, {
      cartographicDegrees: [10, 20, 0],
    });
    assert.equal(result.packets[2].name, "Pipeline");
    assert.equal(result.attributes, collection);
  });
});
