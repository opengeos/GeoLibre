import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchActiveFiresCzml,
  firmsAcquisitionMs,
  firmsDetectionsToCzml,
  firmsRequestUrl,
  parseFirmsCsv,
  FIRMS_SATELLITES,
  type FirmsDetection,
} from "../packages/plugins/src/plugins/gods-eye-view-fire-feeds";
import {
  FIRMS_UPSTREAMS as DEV_FIRMS_UPSTREAMS,
  proxyFirmsRequestGuarded,
} from "../apps/geolibre-desktop/vite-proxy-guard";
import type { ServerResponse } from "node:http";
import { FIRMS_UPSTREAMS as EDGE_FIRMS_UPSTREAMS } from "../workers/tiles/src/allowlisted-fetch";

const VIIRS_HEADER =
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";

function detection(overrides: Partial<FirmsDetection> = {}): FirmsDetection {
  return {
    latitude: 10.01,
    longitude: 20.01,
    frp: 5,
    confidence: "nominal",
    acquiredAtMs: Date.UTC(2026, 8, 22, 12, 0),
    daynight: "D",
    satellite: "N20",
    ...overrides,
  };
}

describe("FIRMS CSV parsing", () => {
  it("reads unpadded UTC acquisition times", () => {
    assert.equal(firmsAcquisitionMs("2026-09-22", "1406"), Date.UTC(2026, 8, 22, 14, 6));
    assert.equal(firmsAcquisitionMs("2026-09-22", "45"), Date.UTC(2026, 8, 22, 0, 45));
    assert.equal(firmsAcquisitionMs("2026-09-22", "0"), Date.UTC(2026, 8, 22, 0, 0));
    assert.ok(Number.isNaN(firmsAcquisitionMs("2026-09-22", "2460")));
    assert.ok(Number.isNaN(firmsAcquisitionMs("22/09/2026", "1406")));
  });

  it("locates columns by name, drops low confidence and malformed rows", () => {
    const csv = [
      VIIRS_HEADER,
      "64.65,24.43,300.4,0.41,0.45,2026-09-22,0018,N20,nominal,2.0NRT,278.6,1.19,N",
      "1.5,127.6,330.0,0.4,0.4,2026-09-22,1406,N20,high,2.0NRT,290.0,-3,D",
      "5.0,5.0,300.0,0.4,0.4,2026-09-22,1406,N20,low,2.0NRT,290.0,9.0,D",
      "95.0,5.0,300.0,0.4,0.4,2026-09-22,1406,N20,high,2.0NRT,290.0,9.0,D",
      "5.0,5.0,300.0",
      "",
    ].join("\r\n");
    const detections = parseFirmsCsv(csv);
    assert.ok(detections);
    assert.equal(detections.length, 2);
    assert.deepEqual(detections[0], {
      latitude: 64.65,
      longitude: 24.43,
      frp: 1.19,
      confidence: "nominal",
      acquiredAtMs: Date.UTC(2026, 8, 22, 0, 18),
      daynight: "N",
      satellite: "NOAA-20",
    });
    // A negative FRP is clamped rather than subtracted from a cluster.
    assert.equal(detections[1].frp, 0);
  });

  it("parses MODIS column names and rejects error pages", () => {
    const modis =
      "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n" +
      "1.49,127.62,310.2,1.02,1.01,2026-09-22,0011,T,66,6.1NRT,290.53,8.78,D\n" +
      "2.00,120.00,305.0,1.00,1.00,2026-09-22,0011,A,12,6.1NRT,290.00,3.10,D\n";
    // MODIS confidence is 0-100; below 30 is FIRMS' low class and is dropped.
    const detections = parseFirmsCsv(modis);
    assert.equal(detections?.length, 1);
    assert.equal(detections?.[0].satellite, "Terra");
    assert.equal(parseFirmsCsv("<html>Service unavailable</html>"), null);
    assert.equal(parseFirmsCsv("Invalid MAP_KEY."), null);
  });
});

describe("FIRMS fire clusters", () => {
  it("merges detections in one cell and ranks clusters by radiative power", () => {
    const { packets, attributes } = firmsDetectionsToCzml([
      detection({ frp: 10, satellite: "N20" }),
      detection({
        latitude: 10.03,
        longitude: 20.03,
        frp: 30,
        satellite: "N21",
        daynight: "N",
        acquiredAtMs: Date.UTC(2026, 8, 22, 20, 0),
      }),
      detection({ latitude: -33.5, longitude: 150.2, frp: 400 }),
    ]);
    assert.equal(packets[0].id, "document");
    assert.equal(packets.length, 3);
    assert.equal(attributes.features.length, 2);
    const [strongest, merged] = attributes.features;
    assert.equal(strongest.properties?.totalFrpMw, 400);
    assert.deepEqual(merged.properties, {
      name: "Active fire (2 detections)",
      detections: 2,
      totalFrpMw: 40,
      maxFrpMw: 30,
      firstDetected: "2026-09-22T12:00:00.000Z",
      lastDetected: "2026-09-22T20:00:00.000Z",
      nightDetections: 1,
      satellites: "N20, N21",
      source: "NASA FIRMS VIIRS",
    });
    assert.deepEqual(merged.geometry.coordinates, [20.02, 10.02]);
    const point = packets[2].point as { pixelSize: number };
    const bigger = packets[1].point as { pixelSize: number };
    assert.ok(bigger.pixelSize > point.pixelSize);
  });

  it("keeps only the strongest clusters under the cap", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      detection({ latitude: index, longitude: index, frp: index }),
    );
    const { attributes } = firmsDetectionsToCzml(many, { maxCells: 5 });
    assert.deepEqual(
      attributes.features.map((feature) => feature.properties?.totalFrpMw),
      [49, 48, 47, 46, 45],
    );
  });
});

describe("FIRMS fetch", () => {
  it("routes every satellite through the relay in dev and at the edge", () => {
    assert.equal(firmsRequestUrl("noaa-20", true), "/firms/viirs/noaa-20");
    assert.equal(
      firmsRequestUrl("suomi-npp", false),
      "https://tiles.geolibre.app/firms/viirs/suomi-npp",
    );
  });

  it("keeps the dev relay, edge relay and client on the same satellites", () => {
    const ids = [...FIRMS_SATELLITES].sort();
    assert.deepEqual(Object.keys(EDGE_FIRMS_UPSTREAMS).sort(), ids);
    assert.deepEqual(Object.keys(DEV_FIRMS_UPSTREAMS).sort(), ids);
    for (const id of ids) {
      assert.equal(
        DEV_FIRMS_UPSTREAMS[id as keyof typeof DEV_FIRMS_UPSTREAMS],
        EDGE_FIRMS_UPSTREAMS[id as keyof typeof EDGE_FIRMS_UPSTREAMS],
      );
    }
  });

  it("uses the satellites that answered when one fails", async () => {
    const requested: string[] = [];
    const payload = await fetchActiveFiresCzml({
      dev: false,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/noaa-21")) return new Response("Bad Gateway", { status: 502 });
        return new Response(
          `${VIIRS_HEADER}\n1.5,127.6,330.0,0.4,0.4,2026-09-22,1406,N20,high,2.0NRT,290.0,4.0,D\n`,
        );
      }) as typeof fetch,
    });
    assert.equal(requested.length, 3);
    assert.equal(payload.attributes.features.length, 1);
    assert.equal(payload.attributes.features[0].properties?.detections, 2);
  });

  it("fails when no satellite could be read", async () => {
    await assert.rejects(
      fetchActiveFiresCzml({
        dev: false,
        fetch: (async () => new Response("<html></html>")) as unknown as typeof fetch,
      }),
      /returned no CSV/,
    );
  });
});

describe("FIRMS dev relay", () => {
  it("answers an unknown satellite with 404 before fetching", async () => {
    const written: { status?: number; body?: unknown } = {};
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body?: unknown) {
        written.status = this.statusCode;
        written.body = body;
      },
    };
    await proxyFirmsRequestGuarded("terra", res as unknown as ServerResponse);
    assert.equal(written.status, 404);
    assert.equal(written.body, "Unknown FIRMS satellite");
  });
});
