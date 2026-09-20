import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCelestrakTleUrl,
  buildUsgsFeedUrl,
  fetchCelestrakSatelliteCzml,
  fetchUsgsEarthquakeCzml,
  parseTle,
  sampleSatellitePosition,
  tleRecordsToCzml,
  usgsGeoJsonToCzml,
} from "../packages/plugins/src/plugins/gods-eye-view-feeds";

const start = new Date("2026-09-19T12:00:00.000Z");
const stop = new Date("2026-09-19T15:00:00.000Z");

const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   26262.50000000  .00016717  00000+0  30178-3 0  9991
2 25544  51.6400 120.0000 0005000  80.0000 280.0000 15.50000000400000
`;

describe("God's Eye View feed helpers", () => {
  it("builds the keyless USGS and CelesTrak feed URLs", () => {
    assert.equal(
      buildUsgsFeedUrl("day", "all"),
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    );
    const celestrak = new URL(buildCelestrakTleUrl("stations"));
    assert.equal(
      celestrak.origin + celestrak.pathname,
      "https://celestrak.org/NORAD/elements/gp.php",
    );
    assert.equal(celestrak.searchParams.get("GROUP"), "stations");
    assert.equal(celestrak.searchParams.get("FORMAT"), "tle");
  });

  it("maps valid USGS points to magnitude-scaled, time-windowed CZML", () => {
    const eventTime = Date.parse("2026-09-19T11:30:00.000Z");
    const packets = usgsGeoJsonToCzml(
      {
        features: [
          {
            id: "abc123",
            geometry: { type: "Point", coordinates: [-122.5, 38.1, 7.2] },
            properties: { mag: 4.5, place: "Test Ridge", time: eventTime },
          },
          {
            id: "bad",
            geometry: { type: "Point", coordinates: [null, 0] },
            properties: { mag: 2, time: eventTime },
          },
        ],
      },
      { start, stop, current: start, multiplier: 60 },
    );
    assert.equal(packets.length, 2);
    assert.deepEqual(packets[0].clock, {
      interval: `${start.toISOString()}/${stop.toISOString()}`,
      currentTime: start.toISOString(),
      multiplier: 60,
      range: "LOOP_STOP",
      step: "SYSTEM_CLOCK_MULTIPLIER",
    });
    assert.equal(packets[1].id, "usgs-abc123");
    assert.equal(packets[1].availability, "2026-09-19T11:00:00.000Z/2026-09-21T11:30:00.000Z");
    assert.deepEqual(packets[1].position, { cartographicDegrees: [-122.5, 38.1, 0] });
    assert.equal((packets[1].point as { pixelSize: number }).pixelSize, 15);
  });

  it("fetches USGS JSON through an injected fetch and returns inline CZML", async () => {
    let requested = "";
    const mockFetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(
        JSON.stringify({
          features: [
            {
              id: "one",
              geometry: { type: "Point", coordinates: [10, 20, 3] },
              properties: { mag: 2, place: "Somewhere", time: start.getTime() },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const packets = await fetchUsgsEarthquakeCzml(
      { start, stop },
      { fetch: mockFetch, period: "hour", magnitude: "2.5" },
    );
    assert.match(requested, /2\.5_hour\.geojson$/);
    assert.equal(packets[1].id, "usgs-one");
  });

  it("parses TLE orbital elements and samples finite positions", () => {
    const records = parseTle(ISS_TLE);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, "ISS (ZARYA)");
    assert.equal(records[0].catalogNumber, "25544");
    assert.equal(records[0].inclinationDeg, 51.64);
    assert.equal(records[0].eccentricity, 0.0005);
    assert.equal(records[0].epoch.toISOString(), "2026-09-19T12:00:00.000Z");
    const position = sampleSatellitePosition(records[0], start);
    assert.ok(Number.isFinite(position.longitude));
    assert.ok(position.longitude >= -180 && position.longitude <= 180);
    assert.ok(Number.isFinite(position.latitude));
    assert.ok(Math.abs(position.latitude) <= records[0].inclinationDeg + 0.1);
    assert.ok(position.altitude > 300_000 && position.altitude < 600_000);
  });

  it("pre-samples a short orbital arc into epoch-relative CZML positions", () => {
    const records = parseTle(ISS_TLE);
    const packets = tleRecordsToCzml(records, {
      start,
      stop: new Date(start.getTime() + 10 * 60_000),
      stepSeconds: 120,
    });
    assert.equal(packets.length, 2);
    const position = packets[1].position as {
      epoch: string;
      interpolationAlgorithm: string;
      cartographicDegrees: number[];
    };
    assert.equal(position.epoch, start.toISOString());
    assert.equal(position.interpolationAlgorithm, "LAGRANGE");
    assert.equal(position.cartographicDegrees.length, 6 * 4);
    assert.deepEqual(
      position.cartographicDegrees.filter((_, index) => index % 4 === 0),
      [0, 120, 240, 360, 480, 600],
    );
  });

  it("fetches and parses CelesTrak text through an injected fetch", async () => {
    let requested = "";
    const mockFetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(ISS_TLE, { status: 200 });
    }) as typeof fetch;
    const packets = await fetchCelestrakSatelliteCzml({
      start,
      stop: new Date(start.getTime() + 4 * 60_000),
      stepSeconds: 120,
      fetch: mockFetch,
      group: "stations",
    });
    assert.match(requested, /GROUP=stations/);
    assert.match(requested, /FORMAT=tle/);
    assert.equal(packets[1].id, "celestrak-25544");
  });
});
