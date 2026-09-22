import type { GeoLibreLayer } from "@geolibre/core";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeLayers,
  summarizeLayers,
} from "../apps/geolibre-desktop/src/lib/assistant/layer-summary";

/** A minimal GeoJSON point layer with one attribute. */
function geojsonLayer(id: string, name: string): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { pop: 42 },
        },
      ],
    },
  } as unknown as GeoLibreLayer;
}

/** A layer with no in-memory GeoJSON, which the SQL workspace never registers. */
function tileLayer(id: string, name: string, type = "vector-tile"): GeoLibreLayer {
  return { id, name, type } as unknown as GeoLibreLayer;
}

describe("summarizeLayers", () => {
  it("pairs each GeoJSON layer with the SQL table registered for it", () => {
    const [cities] = summarizeLayers([geojsonLayer("a", "US Cities")]);
    assert.equal(cities.sqlTable, "us_cities");
    assert.equal(cities.featureCount, 1);
    assert.equal(cities.geometryType, "Point");
    assert.deepEqual(cities.fields, [{ name: "pop", type: "double precision" }]);
  });

  it("keys table names by layer id, not by array position", () => {
    // A vector-tile layer loaded first is skipped by the workspace, so the
    // GeoJSON layer after it must still get its own table (issue #2396).
    const summaries = summarizeLayers([
      tileLayer("tiles", "Buildings"),
      geojsonLayer("cities", "US Cities"),
      tileLayer("dem", "DEM", "raster"),
      geojsonLayer("states", "US States"),
    ]);
    assert.deepEqual(
      summaries.map((summary) => [summary.id, summary.sqlTable]),
      [
        ["tiles", null],
        ["cities", "us_cities"],
        ["dem", null],
        ["states", "us_states"],
      ],
    );
  });

  it("keeps the de-duplicated suffix for layers that share a name", () => {
    const summaries = summarizeLayers([
      geojsonLayer("first", "Cities"),
      tileLayer("tiles", "Cities"),
      geojsonLayer("second", "Cities"),
    ]);
    assert.deepEqual(
      summaries.map((summary) => summary.sqlTable),
      ["cities", null, "cities_2"],
    );
  });
});

describe("describeLayers", () => {
  it("reports the table name against the correct layer line", () => {
    const text = describeLayers([
      tileLayer("tiles", "Buildings"),
      geojsonLayer("cities", "US Cities"),
    ]);
    const [buildings, cities] = text.split("\n");
    assert.doesNotMatch(buildings, /SQL table/);
    assert.match(
      cities,
      /"US Cities" \(geojson, Point, 1 features, SQL table us_cities\) fields: pop:double precision/,
    );
  });

  it("describes an empty map", () => {
    assert.equal(describeLayers([]), "No layers are currently loaded.");
  });
});

describe("display state in the model context", () => {
  // The fast path changes visibility and opacity without going through the
  // agent, so those actions never enter the model's conversation history. The
  // prepended layer context is what lets a follow-up turn ("undo that", "why is
  // it hidden?") see the result.
  it("reports a hidden layer and a faded one, and stays quiet otherwise", () => {
    const layer = (overrides: Partial<GeoLibreLayer>) =>
      ({ ...geojsonLayer("l1", "US Cities"), ...overrides }) as GeoLibreLayer;

    assert.match(describeLayers([layer({ visible: false })]), /, hidden\)/);
    assert.match(describeLayers([layer({ opacity: 0.5 })]), /, opacity 0\.5\)/);

    const normal = describeLayers([layer({ visible: true, opacity: 1 })]);
    assert.doesNotMatch(normal, /hidden/);
    assert.doesNotMatch(normal, /opacity/);
  });

  it("does not call a layer hidden just because the field is absent", () => {
    // A layer built without the field is shown, not hidden; reporting it as
    // hidden would have the model "fix" something that was never wrong.
    assert.doesNotMatch(describeLayers([geojsonLayer("l1", "US Cities")]), /hidden/);
  });
});
