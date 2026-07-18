import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  haversineMeters,
  cumulativeDistances,
  resampleLine,
  computeStats,
  type LngLat,
} from "../packages/plugins/src/plugins/elevation-profile/elevation/geometry";
import {
  formatDistance,
  formatElevation,
  unitSystemLabel,
  UNIT_SYSTEMS,
} from "../packages/plugins/src/plugins/elevation-profile/elevation/format";
import {
  fetchElevations,
  ElevationFetchError,
  MAX_POINTS_PER_REQUEST,
  type FetchLike,
} from "../packages/plugins/src/plugins/elevation-profile/elevation/client";
import { profileToCsv } from "../packages/plugins/src/plugins/elevation-profile/export/csv";
import { buildChartGeometry } from "../packages/plugins/src/plugins/elevation-profile/chart/profileChart";
import {
  encodeLine,
  parseLine,
  getElevationLineValue,
  maybeHandleDeepLink,
  ELEVATION_LINE_PARAM,
} from "../packages/plugins/src/plugins/elevation-profile/utils/deep-link";

const closeTo = (actual: number, expected: number, delta: number): void => {
  assert.ok(
    Math.abs(actual - expected) <= delta,
    `expected ${actual} to be within ${delta} of ${expected}`,
  );
};

describe("elevation-profile geometry", () => {
  it("haversine is zero for identical points and ~111.2 km per degree", () => {
    assert.equal(haversineMeters([0, 0], [0, 0]), 0);
    closeTo(haversineMeters([0, 0], [0, 1]), 111194.9, 1);
    closeTo(haversineMeters([0, 0], [1, 0]), 111194.9, 1);
  });

  it("cumulativeDistances starts at zero and increases monotonically", () => {
    const distances = cumulativeDistances([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
    assert.equal(distances.length, 3);
    assert.equal(distances[0], 0);
    assert.ok(distances[1] > 0);
    assert.ok(distances[2] > distances[1]);
  });

  it("resampleLine keeps the endpoints and hits the target sample count", () => {
    const coords: LngLat[] = [
      [0, 0],
      [0, 2],
    ];
    const { coords: sampled, distances } = resampleLine(coords, 5);
    assert.equal(sampled.length, 5);
    assert.deepEqual(sampled[0], [0, 0]);
    assert.deepEqual(sampled[4], [0, 2]);
    assert.equal(distances[0], 0);
    assert.ok(distances[4] > distances[3]);
  });

  it("resampleLine handles degenerate (single / identical-vertex) lines", () => {
    assert.deepEqual(resampleLine([], 4), { coords: [], distances: [] });
    assert.deepEqual(resampleLine([[1, 2]], 4), {
      coords: [[1, 2]],
      distances: [0],
    });
    const degenerate = resampleLine(
      [
        [1, 1],
        [1, 1],
      ],
      6,
    );
    assert.deepEqual(degenerate.distances, [0, 0]);
  });

  it("computeStats aggregates min/max/gain/loss/totalDistance", () => {
    const stats = computeStats([100, 140, 120, 160], [0, 10, 20, 30]);
    assert.equal(stats.min, 100);
    assert.equal(stats.max, 160);
    assert.equal(stats.gain, 80); // +40 then +40
    assert.equal(stats.loss, 20); // -20
    assert.equal(stats.totalDistance, 30);
  });

  it("computeStats is safe for empty elevations", () => {
    const stats = computeStats([], [0]);
    assert.deepEqual(stats, {
      min: 0,
      max: 0,
      gain: 0,
      loss: 0,
      totalDistance: 0,
    });
  });
});

describe("elevation-profile format", () => {
  it("formats elevation per unit system", () => {
    assert.equal(formatElevation(742, "metric"), "742 m");
    assert.equal(formatElevation(742, "imperial"), "2434 ft");
  });

  it("switches distance units at sensible thresholds", () => {
    assert.equal(formatDistance(850, "metric"), "850 m");
    assert.equal(formatDistance(1500, "metric"), "1.50 km");
    assert.equal(formatDistance(1609.34, "imperial"), "1.00 mi");
    assert.equal(formatDistance(30, "imperial"), "98 ft");
  });

  it("exposes ordered unit systems and labels", () => {
    assert.deepEqual([...UNIT_SYSTEMS], ["metric", "imperial"]);
    assert.equal(unitSystemLabel("metric"), "m / km");
    assert.equal(unitSystemLabel("imperial"), "ft / mi");
  });
});

describe("elevation-profile CSV export", () => {
  it("serializes samples with a header and rounded values", () => {
    const csv = profileToCsv(
      [
        { distance: 0, elevation: 100.126 },
        { distance: 12.345, elevation: 140.2 },
      ],
      [
        [13.4, 52.5],
        [13.5, 52.6],
      ],
    );
    const lines = csv.split("\n");
    assert.equal(lines[0], "index,longitude,latitude,distance_m,elevation_m");
    assert.equal(lines[1], "0,13.4,52.5,0,100.13");
    assert.equal(lines[2], "1,13.5,52.6,12.35,140.2");
  });

  it("leaves coordinate columns blank when coords are missing", () => {
    const csv = profileToCsv([{ distance: 5, elevation: 10 }], []);
    assert.equal(csv.split("\n")[1], "0,,,5,10");
  });
});

describe("elevation-profile chart geometry", () => {
  it("builds monotonic x scaling and clamps the hover lookup", () => {
    const points = [
      { distance: 0, elevation: 100 },
      { distance: 50, elevation: 150 },
      { distance: 100, elevation: 120 },
    ];
    const geometry = buildChartGeometry(points, 200, 120);
    assert.ok(geometry.xScale(100) > geometry.xScale(0));
    assert.equal(geometry.minElevation, 100);
    assert.equal(geometry.maxElevation, 150);
    assert.equal(geometry.totalDistance, 100);
    // Higher elevation maps to a smaller y (SVG top-down).
    assert.ok(geometry.yScale(150) < geometry.yScale(100));
    assert.equal(geometry.indexForX(-9999), 0);
    assert.equal(geometry.indexForX(99999), points.length - 1);
    assert.ok(geometry.linePath.startsWith("M"));
    assert.ok(geometry.areaPath.trim().endsWith("Z"));
  });

  it("centers a flat profile without dividing by zero", () => {
    const geometry = buildChartGeometry(
      [
        { distance: 0, elevation: 500 },
        { distance: 10, elevation: 500 },
      ],
      200,
      120,
    );
    assert.ok(Number.isFinite(geometry.yScale(500)));
  });
});

describe("elevation-profile deep link", () => {
  it("round-trips a line through encode/parse", () => {
    const coords: LngLat[] = [
      [13.41, 52.52],
      [8.23, 46.85],
    ];
    const encoded = encodeLine(coords);
    assert.equal(encoded, "13.41,52.52;8.23,46.85");
    assert.deepEqual(parseLine(encoded), coords);
  });

  it("rejects lines with fewer than two valid vertices", () => {
    assert.equal(parseLine("13.41,52.52"), null);
    assert.equal(parseLine("not,a;line,here"), null);
    assert.equal(parseLine("999,999;8.23,46.85"), null);
  });

  it("reads the raw parameter value", () => {
    const params = new URLSearchParams(`${ELEVATION_LINE_PARAM}=  1,2;3,4  `);
    assert.equal(getElevationLineValue(params), "1,2;3,4");
    assert.equal(getElevationLineValue(new URLSearchParams()), null);
  });

  it("forwards a valid line to the consumer and no-ops otherwise", async () => {
    const seen: LngLat[][] = [];
    const consumer = {
      loadLine(coords: LngLat[]) {
        seen.push(coords);
      },
    };
    await maybeHandleDeepLink(consumer, new URLSearchParams(`${ELEVATION_LINE_PARAM}=1,2;3,4`));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], [
      [1, 2],
      [3, 4],
    ]);

    await maybeHandleDeepLink(consumer, new URLSearchParams());
    assert.equal(seen.length, 1); // unchanged
  });
});

describe("elevation-profile Open-Meteo client", () => {
  const stubFetch =
    (body: unknown, status = 200): FetchLike =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("returns [] for no points and never calls fetch", async () => {
    let called = false;
    const result = await fetchElevations([], () => {
      called = true;
      return Promise.resolve(new Response("{}"));
    });
    assert.deepEqual(result, []);
    assert.equal(called, false);
  });

  it("parses the elevation array on success", async () => {
    const result = await fetchElevations(
      [
        [13.4, 52.5],
        [8.2, 46.8],
      ],
      stubFetch({ elevation: [34, 512] }),
    );
    assert.deepEqual(result, [34, 512]);
  });

  it("rejects when too many points are requested", async () => {
    const points: LngLat[] = Array.from({ length: MAX_POINTS_PER_REQUEST + 1 }, () => [0, 0]);
    await assert.rejects(
      () => fetchElevations(points, stubFetch({ elevation: [] })),
      ElevationFetchError,
    );
  });

  it("rejects on a non-2xx response", async () => {
    await assert.rejects(() => fetchElevations([[0, 0]], stubFetch({}, 503)), ElevationFetchError);
  });

  it("surfaces an aborted (timed-out) request as an ElevationFetchError", async () => {
    const abortFetch: FetchLike = () => Promise.reject(new DOMException("aborted", "AbortError"));
    await assert.rejects(
      () => fetchElevations([[0, 0]], abortFetch),
      (err: unknown) => err instanceof ElevationFetchError && /timed out/i.test(err.message),
    );
  });

  it("rejects when the response length does not match the request", async () => {
    await assert.rejects(
      () =>
        fetchElevations(
          [
            [0, 0],
            [1, 1],
          ],
          stubFetch({ elevation: [1] }),
        ),
      ElevationFetchError,
    );
  });
});
