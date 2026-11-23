import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetZarrTimeAttributeCacheForTests,
  decodeCfTimeValues,
  fetchZarrTimeAttributes,
  parseCfTimeUnits,
  pickTimeDimension,
  pointSeriesFromQueryResult,
  readCoordinateTimeAttributes,
  resolveZarrSelectorDates,
  resolveZarrTimeAxis,
  zarrIndexSeriesSelector,
  zarrPointValue,
} from "../packages/plugins/src/plugins/zarr-time-axis.ts";

// A Zarr cube's time axis reaches the Time Slider as raw coordinate values, so
// the CF `units` attribute is what turns `19723` into an instant
// (opengeos/GeoLibre#1448).

const DAY = 86_400_000;

afterEach(() => {
  __resetZarrTimeAttributeCacheForTests();
});

/** A fetch stub serving a fixed map of paths, 404ing everything else. */
function stubFetch(documents: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const body = documents[url];
    if (body === undefined) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

describe("parseCfTimeUnits", () => {
  it("reads the common CF forms", () => {
    assert.deepEqual(parseCfTimeUnits("days since 1970-01-01"), {
      unitMs: DAY,
      epochMs: 0,
    });
    assert.deepEqual(parseCfTimeUnits("hours since 1900-01-01 00:00:00"), {
      unitMs: 3_600_000,
      epochMs: Date.UTC(1900, 0, 1),
    });
    assert.deepEqual(parseCfTimeUnits("seconds since 1970-01-01T00:00:00Z"), {
      unitMs: 1000,
      epochMs: 0,
    });
  });

  it("applies an explicit UTC offset to the reference date", () => {
    // `+02:00` means the reference wall-clock is two hours ahead of UTC, so the
    // instant it names is two hours earlier.
    assert.equal(
      parseCfTimeUnits("days since 2000-01-01 00:00:00 +02:00")?.epochMs,
      Date.UTC(2000, 0, 1) - 2 * 3_600_000,
    );
  });

  it("does not read a two-digit reference year as a 20th-century one", () => {
    // `Date.UTC(1, ...)` would itself mean 1901, so build the expectation the
    // same way the parser has to: set the full year explicitly.
    const yearOne = new Date(Date.UTC(2000, 0, 1));
    yearOne.setUTCFullYear(1);
    assert.equal(parseCfTimeUnits("days since 0001-01-01")?.epochMs, yearOne.getTime());
    assert.notEqual(parseCfTimeUnits("days since 0001-01-01")?.epochMs, Date.UTC(1901, 0, 1));
  });

  it("rejects units that are not a fixed number of milliseconds", () => {
    // A month is 28-31 days, so decoding it with fixed arithmetic would drift.
    assert.equal(parseCfTimeUnits("months since 1970-01-01"), null);
    assert.equal(parseCfTimeUnits("years since 1970-01-01"), null);
  });

  it("rejects anything that is not a CF time specification", () => {
    assert.equal(parseCfTimeUnits("degrees_north"), null);
    assert.equal(parseCfTimeUnits("days after 1970-01-01"), null);
    assert.equal(parseCfTimeUnits("days since nowhere"), null);
    assert.equal(parseCfTimeUnits(undefined), null);
  });
});

describe("decodeCfTimeValues", () => {
  it("turns raw offsets into epoch milliseconds", () => {
    const units = parseCfTimeUnits("days since 2020-01-01");
    assert.ok(units);
    assert.deepEqual(decodeCfTimeValues([0, 1, 31], units), [
      Date.UTC(2020, 0, 1),
      Date.UTC(2020, 0, 2),
      Date.UTC(2020, 1, 1),
    ]);
  });

  it("keeps index alignment by holding a non-numeric entry as NaN", () => {
    const units = parseCfTimeUnits("days since 2020-01-01");
    assert.ok(units);
    const decoded = decodeCfTimeValues([0, "oops", 2], units);
    assert.equal(decoded.length, 3);
    assert.equal(Number.isNaN(decoded[1]), true);
    assert.equal(decoded[2], Date.UTC(2020, 0, 3));
  });
});

describe("pickTimeDimension", () => {
  it("prefers a recognized time name over other coordinates", () => {
    assert.equal(pickTimeDimension({ band: [1, 2], time: [0, 1], level: [1] }), "time");
    assert.equal(pickTimeDimension({ valid_time: [0, 1] }), "valid_time");
  });

  it("accepts an unconventional name whose values already read as timestamps", () => {
    assert.equal(pickTimeDimension({ epoch: ["2020-01-01", "2020-01-02"] }), "epoch");
  });

  it("leaves a plain index dimension alone", () => {
    // A `month` of 1-12 or a `band` index is not a time axis on its own.
    assert.equal(pickTimeDimension({ month: [1, 2, 3], band: [0, 1] }), null);
    assert.equal(pickTimeDimension({}), null);
    assert.equal(pickTimeDimension(null), null);
  });
});

describe("fetchZarrTimeAttributes", () => {
  it("reads the v2 consolidated metadata, including a multiscale level prefix", async () => {
    const { fetchImpl, requested } = stubFetch({
      "https://example.org/cube.zarr/.zmetadata": {
        metadata: {
          "0/time/.zattrs": {
            units: "days since 1970-01-01",
            calendar: "standard",
          },
        },
      },
    });
    assert.deepEqual(
      await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
        fetchImpl,
      }),
      {
        units: "days since 1970-01-01",
        calendar: "standard",
      },
    );
    assert.deepEqual(requested, ["https://example.org/cube.zarr/.zmetadata"]);
  });

  it("reads a v3 root carrying consolidated metadata", async () => {
    const { fetchImpl } = stubFetch({
      "https://example.org/cube.zarr/zarr.json": {
        consolidated_metadata: {
          metadata: {
            time: { attributes: { units: "hours since 2000-01-01" } },
          },
        },
      },
    });
    assert.deepEqual(
      await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
        fetchImpl,
      }),
      {
        units: "hours since 2000-01-01",
      },
    );
  });

  it("falls back to the coordinate's own document when nothing is consolidated", async () => {
    const { fetchImpl } = stubFetch({
      "https://example.org/cube.zarr/time/.zattrs": {
        units: "days since 1850-01-01",
      },
    });
    assert.deepEqual(
      await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
        fetchImpl,
      }),
      {
        units: "days since 1850-01-01",
      },
    );
  });

  it("retries after a lookup that found nothing", async () => {
    // A transient outage (or a first, unauthenticated add) must not permanently
    // disable the Time Slider binding for a store, so a miss is not cached.
    const offline = stubFetch({});
    assert.equal(
      await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
        fetchImpl: offline.fetchImpl,
      }),
      null,
    );
    const online = stubFetch({
      "https://example.org/cube.zarr/.zmetadata": {
        metadata: { "time/.zattrs": { units: "days since 1970-01-01" } },
      },
    });
    assert.deepEqual(
      await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
        fetchImpl: online.fetchImpl,
      }),
      { units: "days since 1970-01-01" },
    );
  });

  it("caches the lookup so re-binding a layer does not re-walk the store", async () => {
    const { fetchImpl, requested } = stubFetch({
      "https://example.org/cube.zarr/.zmetadata": {
        metadata: { "time/.zattrs": { units: "days since 1970-01-01" } },
      },
    });
    await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
      fetchImpl,
    });
    await fetchZarrTimeAttributes("https://example.org/cube.zarr/", "time", {
      fetchImpl,
    });
    assert.equal(requested.length, 1);
  });

  it("resolves to null when the store exposes no attributes", async () => {
    const { fetchImpl } = stubFetch({});
    assert.equal(
      await fetchZarrTimeAttributes("https://example.org/cube.zarr", "time", {
        fetchImpl,
      }),
      null,
    );
  });
});

describe("resolveZarrTimeAxis", () => {
  it("decodes a CF-encoded numeric axis with the store's units", async () => {
    const { fetchImpl } = stubFetch({
      "https://example.org/cube.zarr/.zmetadata": {
        metadata: { "time/.zattrs": { units: "days since 2020-01-01" } },
      },
    });
    const axis = await resolveZarrTimeAxis(
      "https://example.org/cube.zarr",
      { time: [0, 1, 2], lat: [0], lon: [0] },
      { fetchImpl },
    );
    assert.equal(axis?.dimension, "time");
    assert.deepEqual(axis?.values, [
      Date.UTC(2020, 0, 1),
      Date.UTC(2020, 0, 2),
      Date.UTC(2020, 0, 3),
    ]);
  });

  it("prefers the store's units over reading a bare number as a calendar year", async () => {
    // `1980` is a plausible year *and* a plausible "days since 1970" offset;
    // only the store can say which, so the attribute has to win.
    const { fetchImpl } = stubFetch({
      "https://example.org/cube.zarr/.zmetadata": {
        metadata: { "time/.zattrs": { units: "days since 1970-01-01" } },
      },
    });
    const axis = await resolveZarrTimeAxis(
      "https://example.org/cube.zarr",
      { time: [1980, 1981] },
      { fetchImpl },
    );
    assert.equal(axis?.values[0], 1980 * DAY);
    assert.notEqual(axis?.values[0], Date.UTC(1980, 0, 1));
  });

  it("reports no axis for a calendar Gregorian arithmetic cannot decode", async () => {
    // A 360_day axis decoded as proleptic Gregorian drifts further with every
    // step, so offering no binding beats offering a subtly wrong one.
    const { fetchImpl } = stubFetch({
      "https://example.org/cube.zarr/.zmetadata": {
        metadata: {
          "time/.zattrs": {
            units: "days since 1850-01-01",
            calendar: "360_day",
          },
        },
      },
    });
    assert.equal(
      await resolveZarrTimeAxis("https://example.org/cube.zarr", { time: [0, 1] }, { fetchImpl }),
      null,
    );
  });

  it("reads a string axis without touching the store metadata", async () => {
    const { fetchImpl, requested } = stubFetch({});
    const axis = await resolveZarrTimeAxis(
      "https://example.org/cube.zarr",
      { time: ["2020-01-01", "2020-01-02"] },
      { fetchImpl },
    );
    assert.deepEqual(axis?.values, [Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 2)]);
    assert.deepEqual(requested, []);
  });

  it("uses caller-supplied attributes instead of walking a non-Zarr URL", async () => {
    // The Cloud-Optimized NetCDF flow points `url` at a kerchunk manifest, whose
    // inline `.zattrs` already carry the units.
    const { fetchImpl, requested } = stubFetch({});
    const axis = await resolveZarrTimeAxis(
      "https://example.org/cube.json",
      { time: [0, 1] },
      { fetchImpl, attributes: { units: "days since 1990-01-01" } },
    );
    assert.equal(axis?.values[1], Date.UTC(1990, 0, 2));
    assert.deepEqual(requested, []);
  });

  it("returns null when no dimension is temporal", async () => {
    const { fetchImpl } = stubFetch({});
    assert.equal(
      await resolveZarrTimeAxis("https://example.org/cube.zarr", { month: [1, 2] }, { fetchImpl }),
      null,
    );
    assert.equal(
      await resolveZarrTimeAxis("https://example.org/cube.zarr", {}, { fetchImpl }),
      null,
    );
  });
});

describe("the @carbonplan/zarr-layer coordinate mirror", () => {
  it("still exposes the loaded coordinates as `dimensionValues`", async () => {
    // The renderer keeps every non-spatial coordinate it loaded on a
    // `dimensionValues` instance property. It is declared `private`, so the Zarr
    // temporal adapter reads it through a structural cast (see
    // `readZarrDimensionValues` in components/zarr.ts) and TypeScript cannot
    // catch a rename. If the property moves, Zarr layers silently stop offering
    // a Time Slider binding — so pin the name against the real class here.
    // Imported dynamically: the package publishes an `import`-only exports map,
    // which the test loader cannot resolve from a static specifier.
    const { ZarrLayer } = await import("@carbonplan/zarr-layer");
    const layer = new ZarrLayer({
      id: "drift-guard",
      source: "https://example.org/cube.zarr",
      variable: "tavg",
      colormap: ["#000000", "#ffffff"],
      clim: [0, 1],
    });
    assert.ok(
      "dimensionValues" in layer,
      "@carbonplan/zarr-layer no longer exposes `dimensionValues`; update readZarrDimensionValues",
    );
  });
});

// The same walk serves HTTP, a folder on disk and an Icechunk manifest, so it is
// the reader that differs between them rather than the sequence of documents.
describe("readCoordinateTimeAttributes", () => {
  it("prefers the coordinate's own .zattrs", async () => {
    const asked: string[] = [];
    const attributes = await readCoordinateTimeAttributes(async (key) => {
      asked.push(key);
      return key === "time/.zattrs" ? { units: "days since 1970-01-01" } : undefined;
    }, "time");
    assert.deepEqual(attributes, { units: "days since 1970-01-01" });
    assert.deepEqual(asked, ["time/.zattrs"]);
  });

  it("unwraps a v3 node's attributes", async () => {
    const attributes = await readCoordinateTimeAttributes(
      async (key) =>
        key === "time/zarr.json" ? { attributes: { calendar: "360_day" } } : undefined,
      "time",
    );
    assert.deepEqual(attributes, { calendar: "360_day" });
  });

  it("finds a pyramid's coordinates one level down", async () => {
    const attributes = await readCoordinateTimeAttributes(
      async (key) => (key === "0/time/.zattrs" ? { units: "seconds since 2020-01-01" } : undefined),
      "time",
    );
    assert.deepEqual(attributes, { units: "seconds since 2020-01-01" });
  });

  it("reports nothing when no document declares units or calendar", async () => {
    const asked: string[] = [];
    const attributes = await readCoordinateTimeAttributes(async (key) => {
      asked.push(key);
      return { long_name: "time" };
    }, "time");
    assert.equal(attributes, null);
    // Every layout is tried before giving up: both versions, root and pyramid.
    assert.deepEqual(asked, [
      "time/.zattrs",
      "time/zarr.json",
      "0/time/.zattrs",
      "0/time/zarr.json",
    ]);
  });
});

describe("resolveZarrSelectorDates", () => {
  // NOAA OISST monthly: `time` as days since 1800-01-01, one step per month.
  const days = [safeDays("2020-07-01"), safeDays("2020-08-01"), safeDays("2020-09-01")];
  const axis = {
    dimension: "time",
    values: days.map((d) => Date.UTC(1800, 0, 1) + d * DAY),
  };
  function safeDays(iso: string): number {
    return (Date.parse(iso) - Date.UTC(1800, 0, 1)) / DAY;
  }

  it("turns a date on a CF time axis into its index (#3470)", () => {
    const result = resolveZarrSelectorDates({ time: "2020-08-01" }, { time: days }, axis);
    assert.deepEqual(result, { selector: { time: 1 }, unresolved: [] });
  });

  it("takes a date between steps to the nearest one", () => {
    const result = resolveZarrSelectorDates({ time: "2020-08-20" }, { time: days }, axis);
    assert.deepEqual(result.selector, { time: 2 });
  });

  it("reports a date far outside the axis rather than clamping it", () => {
    const result = resolveZarrSelectorDates({ time: "1990-01-01" }, { time: days }, axis);
    assert.deepEqual(result, { selector: null, unresolved: ["time"] });
  });

  it("leaves indices and natively matching labels alone", () => {
    const result = resolveZarrSelectorDates(
      { time: 1, band: "prec" },
      { time: days, band: ["prec", "tavg"] },
      axis,
    );
    assert.deepEqual(result, { selector: null, unresolved: [] });
  });

  it("reports a label that names no coordinate on a non-time axis", () => {
    const result = resolveZarrSelectorDates(
      { band: "precip" },
      { time: days, band: ["prec", "tavg"] },
      axis,
    );
    assert.deepEqual(result, { selector: null, unresolved: ["band"] });
  });
});

// The pixel time-series chart reads many slices of a cube at a click in one
// query; these pin how the slices are requested and read back.
describe("zarrIndexSeriesSelector", () => {
  it("names slices by position, not by coordinate value", () => {
    // A bare number is matched against coordinate values first (days since
    // 1900 for OISST), so the explicit index type is what makes 0 mean slot 0.
    assert.deepEqual(zarrIndexSeriesSelector("time", [0, 5, 9]), {
      time: { selected: [0, 5, 9], type: "index" },
    });
  });
});

describe("pointSeriesFromQueryResult", () => {
  it("reads one value per requested index from the nested result", () => {
    const result = {
      sst: { 0: [12.5], 5: [27.25] },
      dimensions: ["time", "lat", "lon"],
      coordinates: {},
    };
    const values = pointSeriesFromQueryResult(result, "sst", [0, 5]);
    assert.deepEqual(
      [...values],
      [
        [0, 12.5],
        [5, 27.25],
      ],
    );
  });

  it("turns fill values and missing indices into null gaps", () => {
    const result = { sst: { 0: [Number.NaN], 1: [] } };
    const values = pointSeriesFromQueryResult(result, "sst", [0, 1, 2]);
    assert.deepEqual(
      [...values],
      [
        [0, null],
        [1, null],
        [2, null],
      ],
    );
  });

  it("keeps the first finite sample when a point yields several", () => {
    const values = pointSeriesFromQueryResult({ sst: { 3: [Number.NaN, 8, 9] } }, "sst", [3]);
    assert.equal(values.get(3), 8);
  });

  it("falls back to the first data key when the variable name does not match", () => {
    const result = { dimensions: [], coordinates: {}, analysed_sst: { 2: [1.5] } };
    assert.equal(pointSeriesFromQueryResult(result, "sst", [2]).get(2), 1.5);
  });

  it("does not guess between several data keys", () => {
    const result = { depth: { 2: [5] }, analysed_sst: { 2: [1.5] } };
    assert.equal(pointSeriesFromQueryResult(result, "sst", [2]).get(2), null);
  });

  it("returns all gaps when the layer was not live", () => {
    assert.deepEqual([...pointSeriesFromQueryResult(null, "sst", [0])], [[0, null]]);
  });
});

describe("zarrPointValue", () => {
  it("reads the value on screen", () => {
    assert.equal(zarrPointValue({ sst: [27.5], dimensions: [], coordinates: {} }, "sst"), 27.5);
  });

  it("reports a fill value as null, so Identify can say no data", () => {
    assert.equal(zarrPointValue({ sst: [Number.NaN] }, "sst"), null);
  });

  it("reports a point outside the grid as undefined, so Identify stays silent", () => {
    assert.equal(zarrPointValue({ sst: [] }, "sst"), undefined);
    assert.equal(zarrPointValue(null, "sst"), undefined);
  });
});
