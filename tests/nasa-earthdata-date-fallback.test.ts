import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GibsLayer } from "maplibre-gl-nasa-earthdata";
import {
  addAtAvailableDefaultDate,
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

  it("clamps month and year steps to the target month's length", () => {
    const monthly = { default: "2024-03-31", values: ["2023-01-31/2024-03-31/P1M"] };
    assert.deepEqual(previousGibsDates(monthly, "2024-03-31", 3), [
      "2024-02-29",
      "2024-01-31",
      "2023-12-31",
    ]);
    const yearly = { default: "2024-02-29", values: ["2020-02-29/2024-02-29/P1Y"] };
    assert.deepEqual(previousGibsDates(yearly, "2024-02-29", 1), ["2023-02-28"]);
  });

  it("re-anchors when an earlier date falls in an interval with another period", () => {
    const time = {
      default: "2024-03-31",
      values: ["2024-01-01/2024-02-29/P1D", "2024-02-29/2024-03-31/P1M"],
    };
    // The monthly grid starts on the 29th, so 2024-03-31 steps to 2024-03-29.
    // 2024-02-29 is in both intervals; the daily one takes over from there.
    assert.deepEqual(previousGibsDates(time, "2024-03-31", 3), [
      "2024-03-29",
      "2024-02-29",
      "2024-02-28",
    ]);
  });

  it("keeps the period grid when the date to step from is off it", () => {
    // 2024-03-20 is not on the 12-day grid from 2024-02-25 (or the 8-day one
    // from 2024-02-09), so each step still lands on its interval's own grid.
    const time = {
      default: "2024-03-20",
      values: ["2024-02-09/2024-03-12/P8D", "2024-02-25/2024-03-20/P12D"],
    };
    assert.deepEqual(previousGibsDates(time, "2024-03-20", 3), [
      "2024-03-08",
      "2024-03-04",
      "2024-02-25",
    ]);
  });

  it("does not loop on a zero period", () => {
    const time = { default: "2024-01-10", values: ["2024-01-01/2024-01-10/P0D", "2023-12-31"] };
    assert.deepEqual(previousGibsDates(time, "2024-01-10", 3), ["2023-12-31"]);
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

describe("addAtAvailableDefaultDate", () => {
  type AddCall = { layerId: string; options?: Record<string, unknown> };

  function makeControl() {
    const calls: AddCall[] = [];
    const control = {
      search: (query: string) =>
        [MOPITT, { ...MOPITT, id: "STATIC", time: undefined }].filter((layer) =>
          layer.id.includes(query),
        ),
      addLayer(layerId: string, options?: Record<string, unknown>) {
        calls.push({ layerId, ...(options ? { options } : {}) });
      },
    };
    return { control, calls };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("adds a panel Add at the newest date with imagery", async () => {
    const { control, calls } = makeControl();
    const { fetchImpl } = fakeFetch((url) => (url.includes("/2024-11-01/") ? 404 : 200));
    addAtAvailableDefaultDate(control, () => true, fetchImpl);
    control.addLayer(MOPITT.id);
    assert.equal(calls.length, 0, "the add waits for the probe");
    await settle();
    assert.deepEqual(calls, [{ layerId: MOPITT.id, options: { date: "2024-10-01" } }]);
  });

  it("ignores a repeat Add while that layer is still probing", async () => {
    const { control, calls } = makeControl();
    addAtAvailableDefaultDate(control, () => true, fakeFetch(() => 200).fetchImpl);
    control.addLayer(MOPITT.id);
    control.addLayer(MOPITT.id);
    await settle();
    assert.equal(calls.length, 1);
    // Once the probe settles, a later Add (another instance on purpose) goes through.
    control.addLayer(MOPITT.id);
    await settle();
    assert.equal(calls.length, 2);
  });

  it("keeps the default date when it has imagery", async () => {
    const { control, calls } = makeControl();
    addAtAvailableDefaultDate(control, () => true, fakeFetch(() => 200).fetchImpl);
    control.addLayer(MOPITT.id);
    await settle();
    assert.deepEqual(calls, [{ layerId: MOPITT.id }]);
  });

  it("passes adds that name a date or key, and non-time layers, straight through", () => {
    const { control, calls } = makeControl();
    const { fetchImpl, requested } = fakeFetch(() => 404);
    addAtAvailableDefaultDate(control, () => true, fetchImpl);
    control.addLayer(MOPITT.id, { date: "2024-11-01" });
    control.addLayer(MOPITT.id, { key: "restored" });
    control.addLayer("STATIC");
    assert.equal(calls.length, 3);
    assert.equal(requested.length, 0);
  });

  it("adds nothing once the plugin is deactivated", async () => {
    const { control, calls } = makeControl();
    let active = true;
    addAtAvailableDefaultDate(control, () => active, fakeFetch(() => 200).fetchImpl);
    control.addLayer(MOPITT.id);
    active = false;
    await settle();
    assert.equal(calls.length, 0);
  });

  it("still adds at the default date when the probe throws unexpectedly", async () => {
    const { control, calls } = makeControl();
    // A malformed time domain makes date stepping fail after the first probe.
    const broken = {
      ...MOPITT,
      time: { default: "2024-11-01", values: null as unknown as string[] },
    };
    control.search = () => [broken];
    addAtAvailableDefaultDate(control, () => true, fakeFetch(() => 404).fetchImpl);
    control.addLayer(MOPITT.id);
    await settle();
    assert.deepEqual(calls, [{ layerId: MOPITT.id }]);
  });
});
