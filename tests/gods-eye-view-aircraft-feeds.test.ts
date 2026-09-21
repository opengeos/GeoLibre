import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADSB_LOL_EDGE_URL,
  OPEN_SKY_EDGE_URL,
  aircraftToCzml,
  buildAircraftFeedUrl,
  fetchOpenSkyCzml,
  normalizeAdsbLolAircraft,
  normalizeOpenSkyAircraft,
  predictAircraftPosition,
  type AircraftObservation,
} from "../packages/plugins/src/plugins/gods-eye-view-aircraft-feeds";

const observation: AircraftObservation = {
  id: "abc123",
  callsign: "TEST1",
  longitude: 0,
  latitude: 0,
  altitudeM: 1_000,
  speedMps: 100,
  courseDeg: 90,
  verticalRateMps: 2,
  observedAtMs: Date.parse("2026-09-20T12:00:00Z"),
  onGround: false,
};

describe("God's Eye View aircraft feeds", () => {
  it("normalizes OpenSky array records and their Unix timestamps", () => {
    const row = [
      "ABC123",
      " TEST1 ",
      "United States",
      1_795_000_000,
      1_795_000_005,
      -77,
      39,
      9_000,
      false,
      210,
      270,
      -3,
      null,
      9_200,
    ];
    const value = normalizeOpenSkyAircraft(row, 0);
    assert.equal(value?.id, "abc123");
    assert.equal(value?.callsign, "TEST1");
    assert.equal(value?.altitudeM, 9_200);
    assert.equal(value?.observedAtMs, 1_795_000_005_000);
    assert.equal(value?.verticalRateMps, -3);
  });

  it("normalizes adsb.lol readsb units and age fields", () => {
    const value = normalizeAdsbLolAircraft(
      {
        hex: "~AE1234",
        flight: " RCH123 ",
        lon: -77,
        lat: 39,
        alt_baro: 10_000,
        gs: 200,
        track: 450,
        baro_rate: 600,
        seen_pos: 2,
        t: "C17",
        r: "01-0001",
      },
      1_000_000,
    );
    assert.equal(value?.id, "ae1234");
    assert.equal(value?.observedAtMs, 998_000);
    assert.ok(Math.abs((value?.altitudeM ?? 0) - 3_048) < 0.001);
    assert.ok(Math.abs((value?.speedMps ?? 0) - 102.8888) < 0.001);
    assert.equal(value?.courseDeg, 90);
    assert.ok(Math.abs((value?.verticalRateMps ?? 0) - 3.048) < 0.001);
  });

  it("dead-reckons position and altitude into unique CZML samples", () => {
    const east = predictAircraftPosition(observation, 60);
    assert.ok(east[0] > 0.05 && east[0] < 0.06);
    assert.ok(Math.abs(east[1]) < 0.001);
    assert.equal(east[2], 1_120);

    const now = new Date("2026-09-20T12:00:10Z");
    const payload = aircraftToCzml([observation], now, {
      name: "Test Flights",
      idPrefix: "test",
      color: [1, 2, 3, 255],
      coastSeconds: 45,
    });
    assert.equal(payload.packets.length, 2);
    assert.equal(payload.attributes.features.length, 1);
    assert.deepEqual(
      (payload.packets[1].position as { cartographicDegrees: number[] }).cartographicDegrees.filter(
        (_, index) => index % 4 === 0,
      ),
      [0, 45],
    );
  });

  it("selects matching local and edge proxy routes", () => {
    assert.equal(buildAircraftFeedUrl("opensky", false), OPEN_SKY_EDGE_URL);
    assert.equal(buildAircraftFeedUrl("military", false), ADSB_LOL_EDGE_URL);
    assert.equal(buildAircraftFeedUrl("opensky", true), "/opensky/states");
    assert.equal(buildAircraftFeedUrl("military", true), "/adsb-lol/military");
  });

  it("bounds ADSBDB enrichment to the nearest aircraft budget", async () => {
    const calls: string[] = [];
    const states = Array.from({ length: 12 }, (_, index) => [
      (0x100000 + index).toString(16),
      `TEST${index}`,
      "US",
      null,
      1_795_000_000,
      index,
      0,
      1_000,
      false,
      100,
      90,
      0,
      null,
      1_000,
    ]);
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === OPEN_SKY_EDGE_URL) {
        return new Response(JSON.stringify({ time: 1_795_000_000, states }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          response: { aircraft: { registration: "N1", manufacturer: "Test" } },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const payload = await fetchOpenSkyCzml(
      { start: new Date(), stop: new Date(), current: new Date() },
      { fetch: fetcher, bounds: [-1, -1, 1, 1] },
    );
    assert.equal(payload.attributes.features.length, 12);
    assert.equal(
      calls.filter((url) => url.startsWith("https://tiles.geolibre.app/adsbdb/")).length,
      8,
    );
  });
});
