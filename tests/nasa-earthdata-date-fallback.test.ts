import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GibsLayer } from "maplibre-gl-nasa-earthdata";
import {
  findGibsFallbackDate,
  gibsProbeTileUrl,
  previousGibsDates,
} from "../packages/plugins/src/plugins/nasa-earthdata-date-fallback";

// The MOPITT monthly product from issue #3259: GIBS advertises 2024-11-01 as
// the default, but has no tiles for it.
const MOPITT: GibsLayer = {
  id: "MOPITT_CO_Monthly_Total_Column_Day",
  title: "Carbon Monoxide (L3, Day, Monthly, Total Column, MOPITT, Terra)",
  category: "MOPITT",
  format: "png",
  fileExtension: "png",
  tileMatrixSet: "GoogleMapsCompatible_Level6",
  maxZoom: 6,
  resourceTemplate:
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MOPITT_CO_Monthly_Total_Column_Day/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png",
  time: {
    default: "2024-11-01",
    values: ["2000-03-03/2000-03-31/P28D", "2000-04-01/2024-11-01/P1M"],
  },
};

function fakeFetch(statusFor: (url: string) => number | Error) {
  const requested: string[] = [];
  const fetchImpl = async (url: string) => {
    requested.push(url);
    const status = statusFor(url);
    if (status instanceof Error) throw status;
    return { status };
  };
  return { fetchImpl, requested };
}

describe("previousGibsDates", () => {
  it("steps back by the interval's period", () => {
    assert.deepEqual(previousGibsDates(MOPITT.time!, "2024-11-01", 3), [
      "2024-10-01",
      "2024-09-01",
      "2024-08-01",
    ]);
  });

  it("continues at the previous interval's end", () => {
    assert.deepEqual(previousGibsDates(MOPITT.time!, "2000-05-01", 3), [
      "2000-04-01",
      "2000-03-31",
      "2000-03-03",
    ]);
  });

  it("skips gaps between daily intervals", () => {
    const time = {
      default: "2026-02-08",
      values: ["2025-12-30/2026-02-06/P1D", "2026-02-08/2026-10-26/P1D"],
    };
    assert.deepEqual(previousGibsDates(time, "2026-02-08", 2), ["2026-02-06", "2026-02-05"]);
  });

  it("handles multi-day periods and the start of the domain", () => {
    const time = { default: "2024-01-17", values: ["2024-01-01/2024-01-17/P8D"] };
    assert.deepEqual(previousGibsDates(time, "2024-01-17", 5), ["2024-01-09", "2024-01-01"]);
  });

  it("returns nothing for sub-daily domains", () => {
    const time = {
      default: "2024-01-01T12:00:00Z",
      values: ["2024-01-01T00:00:00Z/2024-01-01T12:00:00Z/PT10M"],
    };
    assert.deepEqual(previousGibsDates(time, time.default, 3), []);
  });
});

describe("findGibsFallbackDate", () => {
  it("builds a concrete zoom-0 tile URL", () => {
    assert.equal(
      gibsProbeTileUrl(MOPITT, "2024-10-01"),
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MOPITT_CO_Monthly_Total_Column_Day/default/2024-10-01/GoogleMapsCompatible_Level6/0/0/0.png",
    );
  });

  it("falls back to the newest earlier date with imagery (issue #3259)", async () => {
    const { fetchImpl, requested } = fakeFetch((url) => (url.includes("/2024-11-01/") ? 404 : 200));
    assert.equal(await findGibsFallbackDate(MOPITT, fetchImpl), "2024-10-01");
    assert.equal(requested.length, 2);
  });

  it("keeps a default date that has imagery, with a single probe", async () => {
    const { fetchImpl, requested } = fakeFetch(() => 200);
    assert.equal(await findGibsFallbackDate(MOPITT, fetchImpl), null);
    assert.equal(requested.length, 1);
  });

  it("gives up after a bounded number of steps", async () => {
    const { fetchImpl, requested } = fakeFetch(() => 404);
    assert.equal(await findGibsFallbackDate(MOPITT, fetchImpl, 3), null);
    assert.equal(requested.length, 4);
  });

  it("leaves the date alone when the probe cannot tell", async () => {
    const offline = fakeFetch(() => new TypeError("Failed to fetch"));
    assert.equal(await findGibsFallbackDate(MOPITT, offline.fetchImpl), null);
    const serverError = fakeFetch((url) => (url.includes("/2024-11-01/") ? 404 : 503));
    assert.equal(await findGibsFallbackDate(MOPITT, serverError.fetchImpl), null);
    assert.equal(serverError.requested.length, 2);
  });

  it("ignores layers without a time dimension", async () => {
    const { fetchImpl, requested } = fakeFetch(() => 404);
    assert.equal(await findGibsFallbackDate({ ...MOPITT, time: undefined }, fetchImpl), null);
    assert.equal(requested.length, 0);
  });
});
