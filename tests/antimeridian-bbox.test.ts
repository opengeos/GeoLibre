import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { datelineBboxParts } from "../packages/processing/src/antimeridian";
import type { Feature, FeatureCollection, Geometry } from "geojson";

function collection(geometries: (Geometry | null)[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geometries.map((geometry) => ({
      type: "Feature",
      properties: {},
      geometry,
    })) as Feature[],
  };
}

function points(coords: [number, number][]): FeatureCollection {
  return collection(coords.map((c) => ({ type: "Point", coordinates: c }) as Geometry));
}

function line(coords: [number, number][]): FeatureCollection {
  return collection([{ type: "LineString", coordinates: coords }]);
}

function ring(coords: [number, number][]): FeatureCollection {
  return collection([{ type: "Polygon", coordinates: [coords] }]);
}

describe("datelineBboxParts", () => {
  it("passes a narrow box straight through", () => {
    const box: [number, number, number, number] = [0, 0, 1, 1];
    assert.deepEqual(datelineBboxParts(points([[0.5, 0.5]]), box), [box]);
  });

  it("splits a Fiji-style extent at the dateline instead of widening it", () => {
    // Fiji spans 177.5E to 179.5W: the raw bbox reads as a 357° span, but the
    // real extent is the 2.5° strip hugging the dateline.
    const parts = datelineBboxParts(
      points([
        [177.5, -18],
        [-179.5, -16],
      ]),
      [-179.5, -18, 177.5, -16],
    );
    assert.deepEqual(parts, [
      [177.5, -18, 180, -16],
      [-180, -18, -179.5, -16],
    ]);
  });

  it("splits a polygon whose vertices outnumber its two extremes", () => {
    // The regression this guards: the extremes alone (180 and -180) look the
    // same for Fiji and for a world layer, so the call has to be made on the
    // whole set. Every vertex here sits between the edges, and the 355° gap
    // across the Pacific is what proves the layer hugs the seam.
    const parts = datelineBboxParts(
      ring([
        [177.2, -17.0],
        [178.5, -16.4],
        [179.9, -17.2],
        [180, -18.5],
        [-180, -18.9],
        [-179.4, -17.2],
        [-178.0, -16.8],
        [177.2, -17.0],
      ]),
      [-180, -18.9, 180, -16.4],
    );
    assert.deepEqual(parts, [
      [177.2, -18.9, 180, -16.4],
      [-180, -18.9, -178.0, -16.4],
    ]);
  });

  it("splits a Chukotka-style extent that touches both edges", () => {
    const parts = datelineBboxParts(
      points([
        [179.9, 65],
        [-179.9, 66],
      ]),
      [-179.9, 65, 179.9, 66],
    );
    assert.deepEqual(parts, [
      [179.9, 65, 180, 66],
      [-180, 65, -179.9, 66],
    ]);
  });

  it("splits a line layer that crosses the dateline", () => {
    const parts = datelineBboxParts(
      line([
        [179, 10],
        [-179, 10],
      ]),
      [-179, 10, 179, 10],
    );
    assert.deepEqual(parts, [
      [179, 10, 180, 10],
      [-180, 10, -179, 10],
    ]);
  });

  it("keeps a genuinely global layer at full longitude", () => {
    // The same >180° bbox shape, but stations all the way round prove the
    // layer really does span the planet, so narrowing it would drop data.
    const parts = datelineBboxParts(
      points([
        [-170, 0],
        [-120, 0],
        [-60, 0],
        [0, 0],
        [60, 0],
        [120, 0],
        [170, 0],
      ]),
      [-170, -10, 170, 10],
    );
    assert.deepEqual(parts, [[-180, -10, 180, 10]]);
  });

  it("splits a Pacific-wide layer whose raw box is well short of the whole globe", () => {
    // 120E to 120W is a 120° window over the seam, but its raw box reads as
    // 270° wide; it must still come back as the two narrow parts.
    const parts = datelineBboxParts(
      points([
        [120, -5],
        [150, 0],
        [-150, 0],
        [-120, 5],
      ]),
      [-120, -5, 150, 5],
    );
    assert.deepEqual(parts, [
      [120, -5, 180, 5],
      [-180, -5, -120, 5],
    ]);
  });

  it("keeps a wide box full-length when a coordinate falls outside the narrow window", () => {
    // Two points hugging the dateline would fit a 20° window, but the station
    // at 0°E proves the layer really does wrap most of the way round.
    const parts = datelineBboxParts(
      points([
        [179, 5],
        [-179, 5],
        [0, 5],
      ]),
      [-179, 5, 179, 5],
    );
    assert.deepEqual(parts, [[-180, 5, 180, 5]]);
  });

  it("decides from the coordinates rather than a wrapped box", () => {
    // A box with west > east is normalised from the layer's own longitudes,
    // so a seam-hugging layer still comes back split at ±180.
    const parts = datelineBboxParts(
      points([
        [179, 5],
        [-179, 5],
      ]),
      [179, 5, -179, 5],
    );
    assert.deepEqual(parts, [
      [179, 5, 180, 5],
      [-180, 5, -179, 5],
    ]);
  });

  it("keeps a wrapped box that spans the whole globe", () => {
    // 180 → -180 is the whole globe, not a zero-width window.
    const parts = datelineBboxParts(
      points([
        [-120, 0],
        [0, 0],
        [120, 0],
      ]),
      [180, -5, -180, 5],
    );
    assert.deepEqual(parts, [[-180, -5, 180, 5]]);
  });

  it("falls back to full longitude when no coordinate can prove a narrow window", () => {
    const parts = datelineBboxParts(collection([]), [-179.5, -18, 177.5, -16]);
    assert.deepEqual(parts, [[-180, -18, 180, -16]]);
    const nulls = datelineBboxParts(collection([null, null]), [-179.5, -18, 177.5, -16]);
    assert.deepEqual(nulls, [[-180, -18, 180, -16]]);
  });

  it("reads longitudes from nested polygon and collection geometries", () => {
    const multi: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [
                [
                  [179, 5],
                  [180, 5],
                  [180, 6],
                  [179, 6],
                  [179, 5],
                ],
              ],
            ],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [{ type: "Point", coordinates: [-179.5, 5.5] }],
          },
        },
      ],
    };
    const parts = datelineBboxParts(multi, [-179.5, 5, 179, 6]);
    assert.deepEqual(parts, [
      [179, 5, 180, 6],
      [-180, 5, -179.5, 6],
    ]);
  });

  it("handles a single longitude without collapsing the circle", () => {
    // One point has no width to speak of, but it must not swallow the globe.
    const parts = datelineBboxParts(points([[42, 7]]), [42, 7, 42, 7]);
    assert.deepEqual(parts, [[42, 7, 42, 7]]);
  });
});
