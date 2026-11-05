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

// Expected values marked "pyproj" were computed independently with GeographicLib
// through pyproj 3.8.0 (PROJ 9.8.1): Geod(ellps="WGS84").inv(...) for lengths and
// .polygon_area_perimeter(...) for areas and perimeters.

function assertClose(actual: number, expected: number, tolerance: number): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

// 1° of the equator: 111,319.491 m on WGS 84 (pyproj).
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
    assertClose(km, 111.31949079327357, 1e-9);
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
    assertClose(sqm, 1230907.2049932536, 1e-3); // pyproj
    assertClose(measurePerimeter(SMALL_BOX), 4437.875315681419, 1e-6); // pyproj
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

  it("measures an Italian polygon with a hole, and a MultiPolygon, on WGS 84", () => {
    // A 0.24° × 0.15° quadrilateral over Milano with a clockwise hole. The
    // sphere of mean radius gives areas about 0.23 % smaller at this latitude.
    const outer = [
      [9.04, 45.39],
      [9.28, 45.39],
      [9.28, 45.54],
      [9.04, 45.54],
      [9.04, 45.39],
    ];
    const hole = [
      [9.15, 45.44],
      [9.15, 45.49],
      [9.21, 45.49],
      [9.21, 45.44],
      [9.15, 45.44],
    ];
    const milano: Geometry = { type: "Polygon", coordinates: [outer, hole] };
    // pyproj: outer 312,909,331.942 m², hole 26,075,803.147 m².
    assertClose(measureArea(milano), 286833528.7953148, 1e-3);
    assertClose(measureArea(milano, "hectares"), 28683.35287953148, 1e-7);
    // Outer 70,881.320 m plus hole 20,498.862 m (pyproj).
    assertClose(measurePerimeter(milano), 91380.1824832992, 1e-6);

    const roma = [
      [12.4, 41.84],
      [12.6, 41.84],
      [12.6, 41.96],
      [12.4, 41.96],
      [12.4, 41.84],
    ];
    const multi: Geometry = { type: "MultiPolygon", coordinates: [[outer], [roma]] };
    // Milano's outer ring plus the Roma box, 221,201,620.853 m² (pyproj).
    assertClose(measureArea(multi), 534110952.7957611, 1e-3);
    // 70,881.320 m + 59,849.237 m (pyproj).
    assertClose(measurePerimeter(multi), 70881.3203196475 + 59849.237104673055, 1e-6);
  });

  it("measures a line with several vertices on WGS 84", () => {
    // Milano, Bologna, Firenze, Roma (pyproj).
    const route: Geometry = {
      type: "LineString",
      coordinates: [
        [9.19, 45.4642],
        [11.3426, 44.4949],
        [11.2558, 43.7696],
        [12.4964, 41.9028],
      ],
    };
    assertClose(measureLength(route), 512802.9859581366, 1e-6);
  });

  it("returns 0 for empty and degenerate geometries", () => {
    assert.equal(measureLength({ type: "LineString", coordinates: [] }), 0);
    assert.equal(measureLength({ type: "LineString", coordinates: [[9.19, 45.4642]] }), 0);
    assert.equal(measureArea({ type: "Polygon", coordinates: [] }), 0);
    assert.equal(measurePerimeter({ type: "Polygon", coordinates: [] }), 0);
    // A "polygon" whose ring is only two vertices encloses nothing.
    const sliver: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 0],
        ],
      ],
    };
    assert.equal(measureArea(sliver), 0);
    assert.equal(measureArea({ type: "MultiPolygon", coordinates: [] }), 0);
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
    // A small box, not a near-global one: 24,619.444 km² (pyproj).
    assertClose(crossingArea, 24619.443759277203, 1e-6);
  });

  it("throws on an unrecognized unit so a typo surfaces as an error", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => measureArea(SMALL_BOX, "hectare" as any));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => measureLength(EQUATOR_SEGMENT, "km" as any));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => measurePerimeter(SMALL_BOX, "kilometre" as any));
  });

  it("throws on a latitude beyond the poles instead of returning NaN", () => {
    const line: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 89],
        [0, 95],
      ],
    };
    const box: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 89],
          [1, 89],
          [1, 95],
          [0, 89],
        ],
      ],
    };
    assert.throws(() => measureLength(line), /latitude must be within ±90°/);
    assert.throws(() => measureArea(box), /latitude must be within ±90°/);
    assert.throws(() => measurePerimeter(box), /latitude must be within ±90°/);
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

  it("measures on the active body's ellipsoid", () => {
    setActiveEllipsoidId("moon");
    // The Moon is a sphere of 1,737,400 m: Geod(a=1737400, f=0) in pyproj.
    assertClose(measureLength(EQUATOR_SEGMENT), 30323.35042414948, 1e-6);
    setActiveEllipsoidId("mars");
    // Mars (IAU 2000) is oblate: Geod(a=3396190, rf=169.894447) in pyproj.
    const box: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 45],
          [1, 45],
          [1, 46],
          [0, 46],
          [0, 45],
        ],
      ],
    };
    assertClose(measureArea(box), 2462993724.759857, 1e-3);
    assertClose(measurePerimeter(box), 201552.9805491792, 1e-6);
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
    assertClose(written, 111.31949079327357, 1e-9);
  });

  it("turns a vertex beyond the poles into a per-feature error, not a NaN", () => {
    const geojson: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "f0", geometry: EQUATOR_SEGMENT, properties: {} },
        {
          type: "Feature",
          id: "f1",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 89],
              [0, 95],
            ],
          },
          properties: {},
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = calculateField(layer as any, [], "len_m", true, "$length()", "number");
    assert.ok(result && "patch" in result);
    assert.equal(result.errors, 1);
    const features = (result.patch.geojson as FeatureCollection).features;
    assertClose(features[0].properties?.len_m as number, 111319.49079327357, 1e-6);
    assert.equal(features[1].properties?.len_m ?? null, null);
  });
});
