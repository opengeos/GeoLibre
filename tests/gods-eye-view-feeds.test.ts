import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCelestrakRequestUrls,
  fetchCelestrakTleText,
  buildCelestrakTleUrl,
  buildUsgsFeedUrl,
  czmlPacketsToAttributeGeoJson,
  CELESTRAK_CORE_SAMPLE_STEP_SECONDS,
  CELESTRAK_CORE_GROUPS,
  fetchCelestrakSatelliteCatalogCzml,
  fetchCelestrakSatelliteCzml,
  fetchUsgsEarthquakeCzml,
  orbitalPeriodSeconds,
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
    const starlink = new URL(buildCelestrakTleUrl("starlink"));
    assert.equal(
      starlink.origin + starlink.pathname,
      "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php",
    );
    assert.equal(starlink.searchParams.get("FILE"), "starlink");
    assert.equal(
      buildCelestrakRequestUrls("starlink")[0],
      "https://tiles.geolibre.app/celestrak/starlink",
    );
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
    // Pinned to the surface; the depth travels in `properties` for Identify.
    assert.deepEqual(packets[1].position, { cartographicDegrees: [-122.5, 38.1, 0] });
    assert.deepEqual(packets[1].properties, {
      magnitude: 4.5,
      depthKm: 7.2,
      place: "Test Ridge",
      time: "2026-09-19T11:30:00.000Z",
    });
    assert.equal((packets[1].point as { pixelSize: number }).pixelSize, 15);
  });

  it("skips a malformed USGS payload instead of throwing", () => {
    const window = { start, stop, current: start, multiplier: 60 };
    // A null collection, a null `features`, and a null entry all degrade to a
    // document packet with nothing in it.
    for (const value of [null, undefined, {}, { features: null }, { features: [null] }]) {
      const packets = usgsGeoJsonToCzml(value, window);
      assert.equal(packets.length, 1);
      assert.equal(packets[0].id, "document");
    }
    // A good feature still survives alongside a broken sibling.
    const mixed = usgsGeoJsonToCzml(
      {
        features: [
          null,
          {
            id: "ok",
            geometry: { type: "Point", coordinates: [1, 2, 3] },
            properties: { mag: 3, time: start.getTime() },
          },
        ],
      },
      window,
    );
    assert.equal(mixed.length, 2);
    assert.equal(mixed[1].id, "usgs-ok");
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

  it("reads CelesTrak directly when the proxy hop throws, not only when it 4xxs", async () => {
    const urls = buildCelestrakRequestUrls("stations");
    assert.ok(urls.length > 1, "there is a fallback URL to fall through to");
    const tried: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      tried.push(url);
      // The edge worker unreachable: a thrown error, not an HTTP status.
      if (url === urls[0]) throw new TypeError("Failed to fetch");
      return new Response(ISS_TLE, { status: 200 });
    }) as typeof fetch;

    const text = await fetchCelestrakTleText("stations", { fetch: mockFetch });
    assert.match(text, /ISS \(ZARYA\)/);
    assert.deepEqual(tried, urls.slice(0, 2));
  });

  it("lets an abort end the CelesTrak read rather than trying the next hop", async () => {
    const controller = new AbortController();
    const mockFetch = (async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    await assert.rejects(
      fetchCelestrakTleText("stations", { fetch: mockFetch, signal: controller.signal }),
      /abort/i,
    );
  });

  it("propagates with SGP4, so the orbit plane drifts as the elements imply", () => {
    const [sgp4] = parseTle(ISS_TLE);
    // The same elements with the raw lines withheld: SGP4 has nothing to build
    // a record from, so this one takes the two-body fallback.
    const keplerian = { ...sgp4, line1: "", line2: "" };
    const aDayOn = new Date(sgp4.epoch.getTime() + 24 * 60 * 60_000);

    const withSgp4 = sampleSatellitePosition(sgp4, aDayOn);
    const withTwoBody = sampleSatellitePosition(keplerian, aDayOn);
    for (const sample of [withSgp4, withTwoBody]) {
      assert.ok(Number.isFinite(sample.longitude));
      assert.ok(sample.altitude > 300_000 && sample.altitude < 600_000);
    }

    // A low orbit's node regresses about five degrees a day under J2 — hundreds
    // of kilometres of cross-track — which mean elements encode but do not
    // state, and which a plain Keplerian reading freezes.
    const separation = Math.hypot(
      withSgp4.cartesian[0] - withTwoBody.cartesian[0],
      withSgp4.cartesian[1] - withTwoBody.cartesian[1],
      withSgp4.cartesian[2] - withTwoBody.cartesian[2],
    );
    assert.ok(separation > 100_000, `expected a day of drift, got ${Math.round(separation)} m`);
  });

  it("resynchronizes past a stray line instead of losing every record after it", () => {
    // A truncated response: an orphan name with no element lines, then a good
    // record. Striding three lines from the orphan would step over line 1 of
    // the record that follows and drop it too.
    const records = parseTle(`ORPHAN NAME WITH NO ELEMENTS
${ISS_TLE}`);
    assert.equal(records.length, 1);
    assert.equal(records[0].catalogNumber, "25544");
    assert.equal(records[0].name, "ISS (ZARYA)");
  });

  it("pre-samples a whole revolution ahead of the window so the path never breaks", () => {
    const records = parseTle(ISS_TLE);
    const period = orbitalPeriodSeconds(records[0]);
    assert.ok(Math.abs(period - 86_400 / 15.5) < 1e-6);
    const stopAt = new Date(start.getTime() + 10 * 60_000);
    const packets = tleRecordsToCzml(records, { start, stop: stopAt, stepSeconds: 120 });
    assert.equal(packets.length, 2);
    const position = packets[1].position as {
      epoch: string;
      interpolationAlgorithm: string;
      cartesian?: number[];
      cartographicDegrees?: number[];
    };
    // Half an orbit of padding on both sides, rounded to whole steps, so samples
    // land exactly on both clock boundaries and the path stays closed there.
    const padding = Math.ceil(Math.ceil(period / 2) / 120) * 120;
    assert.equal(padding, 2880);
    const epoch = new Date(start.getTime() - padding * 1000);
    const sampledUntil = new Date(stopAt.getTime() + padding * 1000);
    assert.equal(position.epoch, epoch.toISOString());
    assert.equal(packets[1].availability, `${epoch.toISOString()}/${sampledUntil.toISOString()}`);
    assert.equal(position.interpolationAlgorithm, "LAGRANGE");

    assert.equal(
      position.cartographicDegrees,
      undefined,
      "longitude interpolation creates broken chords at the antimeridian",
    );
    assert.ok(position.cartesian);
    const offsets = position.cartesian.filter((_, index) => index % 4 === 0);
    assert.equal(offsets.length, (padding * 2 + 600) / 120 + 1);
    assert.equal(position.cartesian.length, offsets.length * 4);
    assert.deepEqual(offsets.slice(0, 3), [0, 120, 240]);
    assert.equal(offsets.at(-1), padding * 2 + 600);
    // The window start must be sampled exactly, not straddled.
    assert.ok(offsets.includes(padding));
    assert.ok(offsets.includes(padding + 600));

    // Cesium draws the path over `currentTime ± lead/trail`, clamped to
    // availability. Lead + trail has to span a full revolution or the orbit
    // renders as a broken arc, and the trail has to be backed by samples that
    // start before the window, or it is clipped away at the clock's opening
    // time — and again on every LOOP_STOP wrap.
    const path = packets[1].path as { leadTime: number; trailTime: number };
    assert.equal(path.leadTime, path.trailTime);
    assert.ok(path.leadTime + path.trailTime >= period);
    assert.ok(path.trailTime <= padding);
    const label = packets[1].label as {
      text: string;
      font: string;
      showBackground: boolean;
      scaleByDistance?: unknown;
      distanceDisplayCondition: { distanceDisplayCondition: number[] };
    };
    // The ISS keeps the one standing label on the globe.
    assert.equal(label.text, "ISS");
    assert.match(label.font, /bold|[6-9]00/);
    assert.equal(label.showBackground, true);
    assert.equal(
      label.scaleByDistance,
      undefined,
      "visible labels must not shrink below legible size",
    );
    assert.deepEqual(label.distanceDisplayCondition.distanceDisplayCondition, [0, 30_000_000]);
    assert.deepEqual(
      (packets[1].point as { color: { rgba: number[] } }).color.rgba,
      [255, 68, 68, 255],
    );
  });

  it("renders non-ISS catalog entries as points without costly orbit padding", () => {
    const geo = parseTle(`GEOSAT
1 99999U 20001A   26262.50000000  .00000000  00000+0  00000-0 0  9990
2 99999   0.0100 120.0000 0001000  80.0000 280.0000  1.00270000400000
`);
    assert.equal(geo.length, 1);
    const packets = tleRecordsToCzml(geo, {
      start,
      stop: new Date(start.getTime() + 60 * 60_000),
      stepSeconds: 120,
    });
    const position = packets[1].position as { epoch: string };
    const stopAt = new Date(start.getTime() + 60 * 60_000);
    assert.equal(position.epoch, start.toISOString());
    assert.equal(packets[1].availability, `${start.toISOString()}/${stopAt.toISOString()}`);
    assert.equal(packets[1].path, undefined);
    // Cesium labels never declutter, so naming the fleet buried the globe (and
    // the ISS's own label) under hundreds of overlapping names up close. The
    // name lives in `properties`, which hover and Identify read.
    assert.equal(packets[1].label, undefined);
    assert.equal(packets[1].name, "GEOSAT");
  });

  it("materializes CZML packet properties as read-only attribute-table rows", () => {
    const records = parseTle(ISS_TLE);
    const packets = tleRecordsToCzml(records, { start, stop, stepSeconds: 120 });
    const packetProperties = packets[1].properties as Record<string, unknown>;
    assert.equal(packetProperties.tleLine1, records[0].line1);
    assert.equal(packetProperties.tleLine2, records[0].line2);
    const table = czmlPacketsToAttributeGeoJson(packets);
    assert.equal(table.type, "FeatureCollection");
    assert.equal(table.features.length, 1, "the CZML document packet is not a data row");
    assert.equal(table.features[0].id, "celestrak-25544");
    assert.equal(table.features[0].geometry.type, "Point");
    assert.equal((table.features[0].geometry as { coordinates: number[] }).coordinates.length, 3);
    assert.deepEqual(table.features[0].properties, {
      name: "ISS (ZARYA)",
      availability: packets[1].availability,
      catalogNumber: "25544",
      inclinationDeg: 51.64,
      orbitalPeriodMinutes: 92.9,
    });
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
    assert.equal(requested, "https://tiles.geolibre.app/celestrak/stations");
    assert.equal(packets[1].id, "celestrak-25544");
  });

  it("samples a large fleet in slices without losing or duplicating packets", async () => {
    // Bigger than one slice, so the chunked path runs: every satellite must
    // still arrive exactly once, under a single document packet.
    const fleet: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const catalogNumber = String(30000 + i).padStart(5, "0");
      fleet.push(`SAT ${i}`);
      fleet.push(
        `1 ${catalogNumber}U 19074A   26262.50000000  .00001200  00000+0  90000-4 0  9991`,
      );
      fleet.push(
        `2 ${catalogNumber}  53.0500 210.0000 0001500  85.0000 275.0000 15.06000000300000`,
      );
    }
    const mockFetch = (async () => new Response(fleet.join("\n"), { status: 200 })) as typeof fetch;

    const packets = await fetchCelestrakSatelliteCzml({
      start,
      stop,
      stepSeconds: 120,
      maxSatellites: 400,
      fetch: mockFetch,
    });

    assert.equal(packets.filter((packet) => packet.id === "document").length, 1);
    const ids = packets.slice(1).map((packet) => packet.id);
    assert.equal(ids.length, 400);
    assert.equal(new Set(ids).size, 400, "no satellite is sampled twice across slice boundaries");
    assert.equal(ids[0], "celestrak-30000");
    assert.equal(ids.at(-1), "celestrak-30399");
  });

  it("keeps an 831-satellite core layer below the autosave snapshot ceiling", () => {
    const template = parseTle(ISS_TLE)[0];
    const records = Array.from({ length: 831 }, (_, index) => ({
      ...template,
      name: `SATELLITE ${index}`,
      catalogNumber: String(30_000 + index),
    }));
    const packets = tleRecordsToCzml(records, {
      start,
      stop,
      stepSeconds: CELESTRAK_CORE_SAMPLE_STEP_SECONDS,
      maxSatellites: records.length,
    });
    const serialized = JSON.stringify({
      source: { type: "czml", data: packets },
      geojson: czmlPacketsToAttributeGeoJson(packets),
    });

    assert.ok(
      Buffer.byteLength(serialized) < 10 * 1024 * 1024,
      "the live core feed must not disable project autosave",
    );
  });

  it("loads the six reference catalog groups, tolerates a failed group, and deduplicates", async () => {
    const secondTle = ISS_TLE.replace("ISS (ZARYA)", "TEST SAT").replaceAll("25544", "40967");
    const requested: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const group =
        url.searchParams.get("GROUP") ??
        url.searchParams.get("FILE") ??
        url.pathname.split("/").at(-1);
      requested.push(group ?? "");
      if (group === "geo") return new Response("unavailable", { status: 503 });
      if (group === "stations") return new Response(ISS_TLE, { status: 200 });
      if (group === "visual") return new Response(ISS_TLE + secondTle, { status: 200 });
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const packets = await fetchCelestrakSatelliteCatalogCzml({
      start,
      stop: new Date(start.getTime() + 4 * 60_000),
      stepSeconds: 120,
      maxSatellites: 2_000,
      fetch: mockFetch,
    });

    assert.deepEqual(
      [...new Set(requested)],
      CELESTRAK_CORE_GROUPS.map(({ group }) => group),
    );
    assert.deepEqual(
      packets.slice(1).map(({ id }) => id),
      ["celestrak-25544", "celestrak-40967"],
    );
    assert.equal((packets[1].properties as { group: string }).group, "stations");
    assert.equal((packets[2].properties as { group: string }).group, "visual");
    assert.equal(packets[2].path, undefined);
    assert.deepEqual(
      (packets[2].point as { color: { rgba: number[] } }).color.rgba,
      [159, 179, 196, 255],
    );
  });
});
