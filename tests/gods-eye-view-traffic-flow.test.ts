import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeFlowTile,
  fetchTrafficFlow,
  flowTilesForBounds,
  matchTrafficFlow,
  TomTomKeyError,
  trafficFlowColor,
  type TrafficFlowSegment,
} from "../packages/plugins/src/plugins/gods-eye-view-traffic-flow";
import {
  clearStreetTrafficRoadCache,
  fetchStreetTrafficCzml,
  streetTrafficToCzml,
} from "../packages/plugins/src/plugins/gods-eye-view-viewport-feeds";

// A minimal Mapbox Vector Tile writer: enough of the spec to build the
// "Traffic flow" layer TomTom serves, so decoding is tested against real bytes.
function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}
const zigzag = (value: number) => (value << 1) ^ (value >> 31);
const tag = (field: number, wire: number) => varint((field << 3) | wire);
function lengthDelimited(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}
function text(field: number, value: string): number[] {
  return lengthDelimited(field, [...new TextEncoder().encode(value)]);
}
function packed(field: number, values: number[]): number[] {
  return lengthDelimited(
    field,
    values.flatMap((value) => varint(value)),
  );
}

type FixtureValue = string | number | boolean;

interface FixtureFeature {
  /** Tile-space vertices, extent 4096. */
  line: Array<[number, number]>;
  properties: Record<string, FixtureValue>;
}

function encodeFlowTile(features: FixtureFeature[], layerName = "Traffic flow"): Uint8Array {
  const keys: string[] = [];
  const values: FixtureValue[] = [];
  const index = <T>(list: T[], value: T) => {
    const found = list.indexOf(value);
    if (found >= 0) return found;
    list.push(value);
    return list.length - 1;
  };
  const encodedFeatures = features.map((feature) => {
    const tags = Object.entries(feature.properties).flatMap(([key, value]) => [
      index(keys, key),
      index(values, value),
    ]);
    const [first, ...rest] = feature.line;
    const geometry = [9, zigzag(first[0]), zigzag(first[1]), 2 | (rest.length << 3)];
    let previous = first;
    for (const point of rest) {
      geometry.push(zigzag(point[0] - previous[0]), zigzag(point[1] - previous[1]));
      previous = point;
    }
    return lengthDelimited(2, [...packed(2, tags), ...tag(3, 0), 2, ...packed(4, geometry)]);
  });
  const encodedValues = values.map((value) => {
    if (typeof value === "string") return lengthDelimited(4, text(1, value));
    if (typeof value === "boolean") return lengthDelimited(4, [...tag(7, 0), value ? 1 : 0]);
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setFloat64(0, value, true);
    return lengthDelimited(4, [...tag(3, 1), ...new Uint8Array(buffer.buffer)]);
  });
  const layer = [
    ...tag(15, 0),
    2,
    ...text(1, layerName),
    ...encodedFeatures.flat(),
    ...keys.flatMap((key) => text(3, key)),
    ...encodedValues.flat(),
    ...tag(5, 0),
    ...varint(4096),
  ];
  return new Uint8Array(lengthDelimited(3, layer));
}

const tile = { z: 12, x: 655, y: 1583 };

function segment(
  coordinates: Array<[number, number]>,
  level: number,
  closure = false,
): TrafficFlowSegment {
  return { coordinates, level, closure, roadType: "Major road" };
}

describe("God's Eye View TomTom traffic flow", () => {
  it("covers a Street Traffic viewport with a handful of zoom-12 tiles", () => {
    const tiles = flowTilesForBounds([-122.42, 37.77, -122.4, 37.79]);
    assert.ok(tiles.length >= 1 && tiles.length <= 4, `${tiles.length} tiles`);
    assert.ok(tiles.every((entry) => entry.z === 12));
  });

  it("refuses an oversized or unusable view instead of spending the key", () => {
    assert.deepEqual(flowTilesForBounds([-130, 30, -120, 40]), []);
    assert.deepEqual(flowTilesForBounds(null), []);
    assert.deepEqual(flowTilesForBounds([1, 1, 0, 2]), []);
  });

  it("decodes congestion, closures and road type from a flow tile", () => {
    const bytes = encodeFlowTile([
      {
        line: [
          [0, 0],
          [2048, 2048],
        ],
        properties: { traffic_level: 0.4, road_type: "Major road" },
      },
      {
        line: [
          [100, 100],
          [200, 100],
        ],
        properties: { road_closure: true, road_type: "Secondary road" },
      },
      {
        // No level and not closed: nothing to color, so skipped.
        line: [
          [300, 300],
          [400, 300],
        ],
        properties: { road_type: "Connecting road" },
      },
      {
        line: [
          [500, 500],
          [600, 500],
        ],
        properties: { traffic_level: 1.7 },
      },
    ]);
    const segments = decodeFlowTile(bytes, tile);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].level, 0.4);
    assert.equal(segments[0].roadType, "Major road");
    assert.equal(segments[0].closure, false);
    assert.equal(segments[0].coordinates.length, 2);
    assert.equal(segments[1].closure, true);
    assert.equal(segments[1].level, 0);
    // An out-of-range level is clamped rather than trusted.
    assert.equal(segments[2].level, 1);
  });

  it("returns nothing for bytes that are not a flow tile", () => {
    assert.deepEqual(decodeFlowTile(new Uint8Array([1, 2, 3]), tile), []);
    const other = encodeFlowTile(
      [
        {
          line: [
            [0, 0],
            [1, 1],
          ],
          properties: { traffic_level: 0.5 },
        },
      ],
      "Incidents",
    );
    assert.deepEqual(decodeFlowTile(other, tile), []);
  });

  it("sends the key to TomTom and tells a rejected key from an outage", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => {
      urls.push(url);
      return new Response(
        encodeFlowTile([
          {
            line: [
              [0, 0],
              [10, 10],
            ],
            properties: { traffic_level: 0.9 },
          },
        ]),
      );
    }) as unknown as typeof fetch;
    const segments = await fetchTrafficFlow([-122.42, 37.77, -122.41, 37.78], "k&y", { fetch: ok });
    assert.ok(segments.length >= 1);
    assert.match(
      urls[0],
      /^https:\/\/api\.tomtom\.com\/traffic\/map\/4\/tile\/flow\/relative\/12\//,
    );
    assert.match(urls[0], /\?key=k%26y$/);

    const rejected = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(
      fetchTrafficFlow([-122.42, 37.77, -122.41, 37.78], "bad", { fetch: rejected }),
      TomTomKeyError,
    );
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(
      fetchTrafficFlow([-122.42, 37.77, -122.41, 37.78], "k", { fetch: down }),
      (error: unknown) => !(error instanceof TomTomKeyError),
    );
  });

  it("colors free flow green, heavy congestion red, and closures dark red", () => {
    assert.deepEqual(trafficFlowColor(0.95, false).slice(0, 3), [34, 197, 94]);
    assert.deepEqual(trafficFlowColor(0.1, false).slice(0, 3), [220, 38, 38]);
    assert.deepEqual(trafficFlowColor(0.95, true).slice(0, 3), [127, 29, 29]);
  });

  it("matches a road to the nearby flow segment, not a parallel one blocks away", () => {
    const road: Array<[number, number]> = [
      [-122.41, 37.78],
      [-122.4, 37.78],
    ];
    const onRoad = segment(
      [
        [-122.412, 37.78001],
        [-122.398, 37.78001],
      ],
      0.3,
    );
    const blockAway = segment(
      [
        [-122.412, 37.782],
        [-122.398, 37.782],
      ],
      0.9,
    );
    assert.equal(matchTrafficFlow(road, [blockAway, onRoad]), onRoad);
    assert.equal(matchTrafficFlow(road, [blockAway]), null);
    assert.equal(matchTrafficFlow(road, []), null);
  });
});

describe("God's Eye View Street Traffic with live flow", () => {
  const window = {
    start: new Date("2026-09-20T00:00:00Z"),
    stop: new Date("2026-09-20T03:00:00Z"),
  };
  const roads = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        id: "way/1",
        geometry: {
          type: "LineString" as const,
          // Long enough (~8.8 km) that its trip time, not the per-window cycle
          // cap, sets the vehicle's pace.
          coordinates: [
            [-122.45, 37.78],
            [-122.35, 37.78],
          ],
        },
        properties: { highway: "primary", name: "Market Street" },
      },
      {
        type: "Feature" as const,
        id: "way/2",
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [-122.41, 37.79],
            [-122.4, 37.79],
          ],
        },
        properties: { highway: "primary", name: "Closed Street" },
      },
    ],
  };
  const flowBounds: [number, number, number, number] = [-122.46, 37.77, -122.34, 37.8];

  it("slows and colors vehicles by congestion and parks none on a closed road", () => {
    const free = streetTrafficToCzml(roads, window);
    const jammed = streetTrafficToCzml(roads, window, {
      bounds: flowBounds,
      segments: [
        segment(
          [
            [-122.451, 37.78],
            [-122.349, 37.78],
          ],
          0.3,
        ),
        segment(
          [
            [-122.411, 37.79],
            [-122.399, 37.79],
          ],
          0,
          true,
        ),
      ],
    });
    // The closed road carries no vehicle; the jammed one keeps its vehicle.
    assert.equal(free.attributes.features.length, 2);
    assert.equal(jammed.attributes.features.length, 1);
    const vehicle = jammed.packets.find((packet) => packet.id === "street-traffic-way/1-0");
    assert.ok(vehicle);
    assert.equal(vehicle.properties?.freeFlowPercent, 30);
    assert.deepEqual(
      (vehicle.point as { color: { rgba: number[] } }).color.rgba,
      trafficFlowColor(0.3, false),
    );
    // Slower traffic completes fewer trips in the same window.
    const samples = (packet: (typeof free.packets)[number]) =>
      (packet.position as { cartographicDegrees: number[] }).cartographicDegrees.length;
    const freeVehicle = free.packets.find((packet) => packet.id === "street-traffic-way/1-0");
    assert.ok(freeVehicle && samples(vehicle) < samples(freeVehicle));
    // Both flow segments are drawn, the closure among them.
    const lines = jammed.packets.filter((packet) => String(packet.id).startsWith("traffic-flow-"));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((line) => line.properties?.closure === true));
    assert.ok(lines.every((line) => (line.polyline as { clampToGround: boolean }).clampToGround));
  });

  it("keeps the keyless simulation when TomTom rejects the key", async () => {
    clearStreetTrafficRoadCache();
    const statuses: string[] = [];
    let overpassCalls = 0;
    const fetcher = (async (url: string) => {
      if (url.includes("api.tomtom.com")) return new Response("", { status: 401 });
      overpassCalls += 1;
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "way",
              id: 1,
              tags: { highway: "primary" },
              geometry: [
                { lat: 37.78, lon: -122.41 },
                { lat: 37.78, lon: -122.4 },
              ],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const bounds: [number, number, number, number] = [-122.42, 37.77, -122.39, 37.79];
    const result = await fetchStreetTrafficCzml(bounds, window, {
      fetch: fetcher,
      tomtomKey: "bad",
      onFlowStatus: (status) => statuses.push(status),
    });
    assert.deepEqual(statuses, ["keyRejected"]);
    assert.equal(result.attributes.features.length, 1);
    assert.ok(!result.packets.some((packet) => String(packet.id).startsWith("traffic-flow-")));
    // A second refresh of the same view re-reads flow but not the road geometry.
    await fetchStreetTrafficCzml(bounds, window, { fetch: fetcher, tomtomKey: "bad" });
    assert.equal(overpassCalls, 1);
    clearStreetTrafficRoadCache();
  });
});
