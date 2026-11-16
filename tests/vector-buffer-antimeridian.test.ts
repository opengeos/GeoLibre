import assert from "node:assert/strict";
import { describe, it } from "node:test";
import area from "@turf/area";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool, runAlgorithmCapture } from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

// GeoLibre#3469: a client (Turf) buffer reaching across the antimeridian came
// back as a ring jumping between 179° and -179°, which draws as a band across
// the whole map; a feature already split there was buffered around a centre on
// the far side of the planet.

function layer(features: Feature[]): GeoLibreLayer {
  return {
    id: "input",
    name: "input",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features },
  };
}

async function runBuffer(features: Feature[], parameters: Record<string, unknown>) {
  const tool = getVectorTool("buffer");
  assert.ok(tool);
  const output = await runAlgorithmCapture(
    tool,
    { layer: "input", units: "kilometers", ...parameters },
    { layers: [layer(features)], log: () => {} },
  );
  assert.ok(output);
  return output as FeatureCollection;
}

/** Every ring of a polygonal geometry. */
function rings(geometry: Geometry): Position[][] {
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  throw new Error(`unexpected ${geometry.type}`);
}

/** Assert no ring leaves ±180 or jumps across it (an edge along a pole is fine). */
function assertNoWrap(geometry: Geometry): void {
  for (const ring of rings(geometry)) {
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      assert.ok(lon >= -180 && lon <= 180, `longitude ${lon} out of range`);
      if (i === 0) continue;
      const [prevLon, prevLat] = ring[i - 1];
      const alongPole = Math.abs(lat) === 90 && lat === prevLat;
      assert.ok(
        alongPole || Math.abs(lon - prevLon) <= 180,
        `ring jumps from ${prevLon} to ${lon}`,
      );
    }
  }
}

const CIRCLE_KM2 = Math.PI * 100 * 100;

describe("buffer across the antimeridian (#3469)", () => {
  it("cuts a buffer that reaches across 180° instead of wrapping it", async () => {
    // Funafuti, 100 km from the antimeridian's west side.
    const output = await runBuffer(
      [
        {
          type: "Feature",
          properties: { name: "Funafuti" },
          geometry: { type: "Point", coordinates: [179.2, -8.5] },
        },
      ],
      { distance: 100 },
    );
    const [buffered] = output.features;
    assert.equal(buffered.properties?.name, "Funafuti");
    assert.equal(buffered.geometry.type, "MultiPolygon");
    assertNoWrap(buffered.geometry);
    // The two halves add up to the whole disc.
    const km2 = area(buffered) / 1e6;
    assert.ok(Math.abs(km2 - CIRCLE_KM2) / CIRCLE_KM2 < 0.02, `area ${km2}`);
  });

  it("buffers a feature already split at 180° around its real centre", async () => {
    const fiji: Feature = {
      type: "Feature",
      properties: { name: "Fiji" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [178, -17],
              [180, -17],
              [180, -16],
              [178, -16],
              [178, -17],
            ],
          ],
          [
            [
              [-180, -17],
              [-179, -17],
              [-179, -16],
              [-180, -16],
              [-180, -17],
            ],
          ],
        ],
      },
    };
    const output = await runBuffer([fiji], { distance: 50 });
    const [buffered] = output.features;
    assert.equal(buffered.properties?.name, "Fiji");
    assertNoWrap(buffered.geometry);
    // Grown by roughly 50 km on every side of a 3°x1° box; a buffer around a
    // centre on the far side of the planet comes out badly distorted.
    const km2 = area(buffered) / 1e6;
    const inputKm2 = area(fiji) / 1e6;
    assert.ok(km2 > inputKm2 * 2 && km2 < inputKm2 * 3.5, `area ${km2} vs input ${inputKm2}`);
  });

  it("closes a buffer around a pole through the pole", async () => {
    const output = await runBuffer(
      [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [139.27, -90] },
        },
      ],
      { distance: 100 },
    );
    const [buffered] = output.features;
    assertNoWrap(buffered.geometry);
    const km2 = area(buffered) / 1e6;
    assert.ok(Math.abs(km2 - CIRCLE_KM2) / CIRCLE_KM2 < 0.02, `area ${km2}`);
  });

  it("keeps a two-sided buffer across 180° as a band", async () => {
    const output = await runBuffer(
      [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-179.5, 52] } }],
      { distance: 100, side: "both" },
    );
    const [buffered] = output.features;
    assertNoWrap(buffered.geometry);
    const km2 = area(buffered) / 1e6;
    assert.ok(Math.abs(km2 - CIRCLE_KM2) / CIRCLE_KM2 < 0.02, `area ${km2}`);
  });

  it("leaves a buffer away from the antimeridian untouched", async () => {
    const output = await runBuffer(
      [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-78, 35] } }],
      { distance: 100 },
    );
    assert.equal(output.features[0].geometry.type, "Polygon");
    assertNoWrap(output.features[0].geometry);
  });
});
