import assert from "node:assert/strict";
import { it, mock } from "node:test";
import type { FeatureCollection } from "geojson";
import { updateGeoJsonSourceData } from "../packages/map/src/geojson-source-data";

const data: FeatureCollection = { type: "FeatureCollection", features: [] };

it("updates the existing source with the authored data", () => {
  const values: unknown[] = [];
  updateGeoJsonSourceData(
    {
      setData(value) {
        values.push(value);
        return Promise.resolve();
      },
    },
    data,
  );
  assert.deepEqual(values, [data]);
});

it("reports rejected source updates without an unhandled rejection", async () => {
  const failure = new Error("Worker update failed");
  const warnings = mock.method(console, "warn", () => {});
  try {
    updateGeoJsonSourceData({ setData: () => Promise.reject(failure) }, data);
    await Promise.resolve();
    assert.deepEqual(
      warnings.mock.calls.map((call) => call.arguments),
      [["Failed to update map source", failure]],
    );
  } finally {
    warnings.mock.restore();
  }
});

it("accepts synchronous source adapters and missing optional sources", () => {
  let calls = 0;
  updateGeoJsonSourceData(
    {
      setData: () => {
        calls += 1;
      },
    },
    data,
  );
  updateGeoJsonSourceData(undefined, data);
  assert.equal(calls, 1);
});

it("preserves synchronous source errors for the caller", () => {
  const failure = new Error("Invalid source state");
  assert.throws(
    () =>
      updateGeoJsonSourceData(
        {
          setData: () => {
            throw failure;
          },
        },
        data,
      ),
    (error) => error === failure,
  );
});
