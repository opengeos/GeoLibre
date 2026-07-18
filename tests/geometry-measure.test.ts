import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setActiveEllipsoidId } from "@geolibre/core";
import type { FeatureCollection, Geometry } from "geojson";
import { calculateField } from "../apps/geolibre-desktop/src/lib/attribute-columns";
import { compileExpression } from "../apps/geolibre-desktop/src/lib/attribute-expression";
import {
  detectGeometryFamilies,
  measureArea,
  measureLength,
  measurePerimeter,
} from "../apps/geolibre-desktop/src/lib/geometry-measure";

// A 1° segment along the equator and a small square near the equator give stable
// reference values against Earth's default mean radius (~6371008.77 m).
const EQUATOR_SEGMENT: Geometry = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [1, 0],
  ],
};

// 0.01° × 0.01° box near the equator (roughly 1.11 km on a side).
const SMALL_BOX: Geometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
      [0, 0],
    ],
  ],
};

describe("geometry-measure", () => {
  afterEach(() => {
    // The active ellipsoid is a global singleton; keep tests independent.
    setActiveEllipsoidId("earth");
  });

  it("measures a line's geodesic length, with unit conversion", () => {
    const km = measureLength(EQUATOR_SEGMENT, "kilometers");
    assert.ok(Math.abs(km - 111.19) < 0.2, `expected ~111.19 km, got ${km}`);
    // Units are consistent multiples of the base meter value.
    const meters = measureLength(EQUATOR_SEGMENT, "meters");
    assert.ok(Math.abs(meters / km - 1000) < 1e-6);
    const feet = measureLength(EQUATOR_SEGMENT, "feet");
    assert.ok(Math.abs(feet / meters - 3.280839895) < 1e-6);
  });

  it("sums MultiLineString parts and defaults to meters", () => {
    const multi: Geometry = {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [0, 0],
          [1, 0],
        ],
      ],
    };
    const single = measureLength(EQUATOR_SEGMENT);
    assert.ok(Math.abs(measureLength(multi) - single * 2) < 1e-6);
  });

  it("returns 0 length for geometries with no linear extent", () => {
    assert.equal(measureLength({ type: "Point", coordinates: [0, 0] }), 0);
    assert.equal(measureLength(SMALL_BOX), 0);
    assert.equal(measureLength(null), 0);
  });

  it("measures polygon area and perimeter", () => {
    const sqm = measureArea(SMALL_BOX, "square-meters");
    // ~1.11 km per side → ~1.23e6 m².
    assert.ok(sqm > 1.2e6 && sqm < 1.26e6, `unexpected area ${sqm}`);
    const hectares = measureArea(SMALL_BOX, "hectares");
    assert.ok(Math.abs(sqm / hectares - 10000) < 1e-6);

    const perimeterM = measurePerimeter(SMALL_BOX, "meters");
    const sideM = measureLength(
      {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0.01, 0],
        ],
      },
      "meters",
    );
    // Four ~equal sides near the equator.
    assert.ok(Math.abs(perimeterM - sideM * 4) < sideM * 0.02);
  });

  it("subtracts holes from polygon area", () => {
    const withHole: Geometry = {
      type: "Polygon",
      coordinates: [
        SMALL_BOX.type === "Polygon" ? SMALL_BOX.coordinates[0] : [],
        [
          [0.002, 0.002],
          [0.008, 0.002],
          [0.008, 0.008],
          [0.002, 0.008],
          [0.002, 0.002],
        ],
      ],
    };
    assert.ok(measureArea(withHole) < measureArea(SMALL_BOX));
  });

  it("returns 0 area/perimeter for non-polygon geometries", () => {
    assert.equal(measureArea(EQUATOR_SEGMENT), 0);
    assert.equal(measurePerimeter(EQUATOR_SEGMENT), 0);
    assert.equal(measureArea(null), 0);
  });

  it("handles polygons that cross the antimeridian", () => {
    // A 2°×1° box spanning 179° → -179°. Its longitude delta must be treated as
    // the short 2° step, not a 358° one, so its area matches an equivalent box
    // that does not cross ±180°.
    const crossing: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [179, 0],
          [-179, 0],
          [-179, 1],
          [179, 1],
          [179, 0],
        ],
      ],
    };
    const equivalent: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const crossingArea = measureArea(crossing, "square-kilometers");
    const equivArea = measureArea(equivalent, "square-kilometers");
    assert.ok(
      Math.abs(crossingArea - equivArea) / equivArea < 1e-6,
      `crossing ${crossingArea} vs equivalent ${equivArea}`,
    );
    // Sanity: this is a small (~25k km²) box, not a near-global one.
    assert.ok(crossingArea < 30000, `unexpectedly large area ${crossingArea}`);
  });

  it("throws on an unrecognized unit so a typo surfaces as an error", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => measureArea(SMALL_BOX, "hectare" as any));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => measureLength(EQUATOR_SEGMENT, "km" as any));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => measurePerimeter(SMALL_BOX, "kilometre" as any));
  });

  it("measures and classifies GeometryCollections by their members", () => {
    const collection: Geometry = {
      type: "GeometryCollection",
      geometries: [SMALL_BOX, EQUATOR_SEGMENT],
    };
    // measure* recurse into the collection.
    assert.equal(measureArea(collection), measureArea(SMALL_BOX));
    assert.equal(measureLength(collection), measureLength(EQUATOR_SEGMENT));
    // A collection reports every base family it contains.
    const feature = (geometry: Geometry) =>
      ({ type: "Feature", geometry, properties: {} }) as const;
    assert.deepEqual([...detectGeometryFamilies([feature(collection)])].sort(), [
      "line",
      "polygon",
    ]);
    assert.deepEqual(
      [
        ...detectGeometryFamilies([
          feature({ type: "GeometryCollection", geometries: [SMALL_BOX] }),
        ]),
      ],
      ["polygon"],
    );
  });

  it("honors the active ellipsoid's radius", () => {
    const earth = measureLength(EQUATOR_SEGMENT, "meters");
    setActiveEllipsoidId("moon");
    const moon = measureLength(EQUATOR_SEGMENT, "meters");
    // The Moon's radius is roughly 27% of Earth's, so the same span is shorter.
    assert.ok(moon < earth * 0.3, `moon ${moon} vs earth ${earth}`);
  });

  it("detects the set of present geometry families", () => {
    const feature = (geometry: Geometry) =>
      ({ type: "Feature", geometry, properties: {} }) as const;
    assert.deepEqual([...detectGeometryFamilies([feature(SMALL_BOX)])], ["polygon"]);
    assert.deepEqual([...detectGeometryFamilies([feature(EQUATOR_SEGMENT)])], ["line"]);
    assert.deepEqual(
      [...detectGeometryFamilies([feature(SMALL_BOX), feature(EQUATOR_SEGMENT)])].sort(),
      ["line", "polygon"],
    );
    assert.equal(detectGeometryFamilies([]).size, 0);
    assert.deepEqual(
      [...detectGeometryFamilies([feature({ type: "Point", coordinates: [0, 0] })])],
      ["point"],
    );
  });
});

describe("geometry helpers in the field calculator", () => {
  afterEach(() => setActiveEllipsoidId("earth"));

  it("exposes $length/$perimeter/$area bound to the feature geometry", () => {
    const compiled = compileExpression('$area("hectares")', []);
    const value = compiled.evaluate({}, 0, SMALL_BOX);
    assert.equal(value, measureArea(SMALL_BOX, "hectares"));
  });

  it("cannot be shadowed by a same-named field, and defaults units", () => {
    const compiled = compileExpression("$length()", ["$length"]);
    assert.equal(
      compiled.evaluate({ $length: 999 }, 0, EQUATOR_SEGMENT),
      measureLength(EQUATOR_SEGMENT),
    );
  });

  it("writes a geometry-derived column via calculateField", () => {
    const geojson: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "f0",
          geometry: EQUATOR_SEGMENT,
          properties: { name: "line" },
        },
      ],
    };
    const layer = {
      id: "l1",
      name: "L",
      type: "geojson" as const,
      source: { type: "geojson" as const },
      visible: true,
      opacity: 1,
      style: {},
      metadata: {},
      geojson,
    };
    const result = calculateField(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      layer as any,
      ["name"],
      "len_km",
      true,
      '$length("kilometers")',
      "number",
    );
    assert.ok(result && "patch" in result);
    const written = (result.patch.geojson as FeatureCollection).features[0].properties
      ?.len_km as number;
    assert.ok(Math.abs(written - 111.19) < 0.2, `got ${written}`);
  });
});
