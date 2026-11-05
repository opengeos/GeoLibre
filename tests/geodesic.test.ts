/**
 * Tests for the ellipsoidal distance and area helpers in `@geolibre/core`
 * (GeoLibre#3267).
 *
 * Every expected value was computed independently with GeographicLib through
 * pyproj 3.8.0 (PROJ 9.8.1): `Geod(ellps="WGS84").inv(...)` for distances and
 * `.polygon_area_perimeter(...)` for areas, with `Geod(a=3396190,
 * rf=169.894447)` for Mars and `Geod(a=1737400, f=0)` for the Moon.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  centralAngle,
  geodesicDistance,
  geodesicRadiusBounds,
  geodesicLength,
  geodesicRingArea,
  getEllipsoid,
  isLonLat,
  latLonBoxArea,
  setActiveEllipsoidId,
  withinGeodesicDistance,
} from "@geolibre/core";
import type { Position } from "geojson";

afterEach(() => setActiveEllipsoidId("earth"));

function assertClose(actual: number, expected: number, tolerance: number): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

const TORINO: Position = [7.6869, 45.0703];
const TRIESTE: Position = [13.77, 45.65];

describe("geodesicDistance", () => {
  it("measures Torino–Trieste on the WGS 84 ellipsoid", () => {
    // The sphere of mean radius gives 479,510 m, 1,323 m short.
    assertClose(geodesicDistance(TORINO, TRIESTE), 480833.0879751366, 1e-6);
  });

  it("measures one degree of the equator as the equatorial radius sees it", () => {
    assertClose(geodesicDistance([0, 0], [1, 0]), 111319.49079327357, 1e-6);
  });

  it("is zero between a position and itself, and ignores Z", () => {
    assert.equal(geodesicDistance(TORINO, TORINO), 0);
    assert.equal(
      geodesicDistance([7.6869, 45.0703, 240], [13.77, 45.65, 2]),
      geodesicDistance(TORINO, TRIESTE),
    );
  });

  it("uses the active body's own ellipsoid", () => {
    setActiveEllipsoidId("mars");
    assertClose(geodesicDistance([0, 0], [0, 10]), 585893.7980130863, 1e-6);
    setActiveEllipsoidId("moon");
    // The Moon is a sphere (f = 0): one degree of arc of radius 1,737,400 m.
    assertClose(geodesicDistance([0, 0], [1, 0]), 30323.35042414948, 1e-6);
  });

  it("takes an explicit ellipsoid over the active one", () => {
    setActiveEllipsoidId("moon");
    assertClose(geodesicDistance([0, 0], [0, 10], getEllipsoid("mars")), 585893.7980130863, 1e-6);
  });
});

describe("geodesicLength", () => {
  it("sums the segments of a line", () => {
    // Milano, Bologna, Firenze, Roma.
    const route: Position[] = [
      [9.19, 45.4642],
      [11.3426, 44.4949],
      [11.2558, 43.7696],
      [12.4964, 41.9028],
    ];
    assertClose(geodesicLength(route), 512802.9859581366, 1e-6);
  });

  it("is zero for an empty or single-vertex run", () => {
    assert.equal(geodesicLength([]), 0);
    assert.equal(geodesicLength([TORINO]), 0);
  });
});

describe("geodesicRingArea", () => {
  // A 0.24° × 0.15° quadrilateral over Milano, counter-clockwise.
  const MILANO: Position[] = [
    [9.04, 45.39],
    [9.28, 45.39],
    [9.28, 45.54],
    [9.04, 45.54],
  ];

  it("measures a ring whatever its winding order or closure", () => {
    assertClose(geodesicRingArea(MILANO), 312909331.9423065, 1e-3);
    assertClose(geodesicRingArea([...MILANO].reverse()), 312909331.9423065, 1e-3);
    assertClose(geodesicRingArea([...MILANO, MILANO[0]]), 312909331.9423065, 1e-3);
  });

  it("measures a box that crosses the antimeridian like the same box elsewhere", () => {
    const crossing: Position[] = [
      [179, 0],
      [-179, 0],
      [-179, 1],
      [179, 1],
      [179, 0],
    ];
    assertClose(geodesicRingArea(crossing), 24619443759.277203, 1e-3);
  });

  it("measures a ring around the pole as the cap it encloses", () => {
    const aroundPole: Position[] = [
      [0, 85],
      [90, 85],
      [180, 85],
      [-90, 85],
    ];
    assertClose(geodesicRingArea(aroundPole), 624537055980, 1e-3);
    assertClose(geodesicRingArea([...aroundPole].reverse()), 624537055980, 1e-3);
  });

  it("measures a ring enclosing more than half the body as its smaller side", () => {
    // A ring along 10°S, one vertex per degree, encloses the northern ~59 % of
    // the ellipsoid. GeographicLib reduces the signed area to at most half the
    // body, so the ring is measured as the southern ~41 % on the other side; the
    // cap north of it is the zone area from 10°S to the pole.
    const along10S: Position[] = Array.from({ length: 360 }, (_, i) => [i - 180, -10]);
    const whole = latLonBoxArea(-180, -90, 180, 90);
    const northOf10S = latLonBoxArea(-180, -10, 180, 90);
    assert.ok(northOf10S > whole / 2);
    const area = geodesicRingArea(along10S);
    assert.ok(area < whole / 2);
    // One-degree geodesic segments bulge slightly towards the pole, hence 1e-4.
    assertClose(area / (whole - northOf10S), 1, 1e-4);
  });

  it("is zero for degenerate rings", () => {
    assert.equal(geodesicRingArea([]), 0);
    assert.equal(geodesicRingArea([TORINO, TRIESTE]), 0);
    // Three vertices on the equator enclose nothing.
    assert.equal(
      geodesicRingArea([
        [0, 0],
        [1, 0],
        [2, 0],
      ]),
      0,
    );
  });

  it("uses the active body's own ellipsoid", () => {
    setActiveEllipsoidId("mars");
    const box: Position[] = [
      [0, 45],
      [1, 45],
      [1, 46],
      [0, 46],
    ];
    assertClose(geodesicRingArea(box), 2462993724.759857, 1e-3);
  });
});

describe("geodesicRadiusBounds", () => {
  it("are b²/a and a²/b, with a 1e-9 margin", () => {
    // WGS 84: b = 6,356,752.314 m.
    const { min, max } = geodesicRadiusBounds(getEllipsoid("earth"));
    assertClose(min, 6335439.327, 0.01);
    assertClose(max, 6399593.626, 0.01);
    const moon = geodesicRadiusBounds(getEllipsoid("moon"));
    assertClose(moon.min, 1737400, 0.01);
    assertClose(moon.max, 1737400, 0.01);
  });

  it("bound the geodesic distance from the central angle", () => {
    // Pairs from short to near-antipodal, including meridian steps at the
    // equator and parallels near the pole, where the bounds are tightest.
    const pairs: [Position, Position][] = [
      [TORINO, TRIESTE],
      [
        [0, 0],
        [0, 0.001],
      ],
      [
        [0, 0],
        [0.001, 0],
      ],
      [
        [0, 89.99],
        [90, 89.99],
      ],
      [
        [179.9, -30],
        [-179.9, -30.1],
      ],
      [
        [0, 0],
        [179.5, 0.4],
      ],
      [
        [-70, -50],
        [120, 60],
      ],
      // Near-antipodal, where a haversine central angle loses precision.
      [
        [0, 0.3],
        [179.9999, -0.3],
      ],
    ];
    for (const id of ["earth", "mars", "moon"]) {
      const ellipsoid = getEllipsoid(id);
      const { min, max } = geodesicRadiusBounds(ellipsoid);
      for (const [p, q] of pairs) {
        const angle = centralAngle(p, q);
        const d = geodesicDistance(p, q, ellipsoid);
        assert.ok(angle * min <= d && d <= angle * max, `${id} ${p} → ${q}`);
        assert.equal(withinGeodesicDistance(p, q, d, ellipsoid), true);
        assert.equal(withinGeodesicDistance(p, q, d * (1 - 1e-12), ellipsoid), false);
      }
    }
  });
});

describe("a prolate figure", () => {
  // Not in ELLIPSOIDS, but the helpers take any ellipsoid: b > a here.
  const prolate = {
    id: "prolate",
    name: "Prolate test figure",
    semiMajorAxisMeters: 6378137,
    inverseFlattening: -298.257223563,
  };

  it("keeps min below max and bounds the geodesic", () => {
    const { min, max } = geodesicRadiusBounds(prolate);
    assert.ok(min < max);
    const pairs: [Position, Position][] = [
      [TORINO, TRIESTE],
      [
        [0, 0],
        [0, 0.001],
      ],
      [
        [0, 89.99],
        [90, 89.99],
      ],
    ];
    for (const [p, q] of pairs) {
      const angle = centralAngle(p, q);
      const d = geodesicDistance(p, q, prolate);
      assert.ok(angle * min <= d && d <= angle * max, `${p} → ${q}`);
    }
  });

  it("measures the whole spheroid like the closed form for its surface", () => {
    // S = 2πa² (1 + b / (a ε) · asin ε), ε = sqrt(1 − a²/b²), for b > a.
    const a = prolate.semiMajorAxisMeters;
    const b = a * (1 - 1 / prolate.inverseFlattening);
    const eps = Math.sqrt(1 - (a * a) / (b * b));
    const surface = 2 * Math.PI * a * a * (1 + (b / (a * eps)) * Math.asin(eps));
    assertClose(latLonBoxArea(-180, -90, 180, 90, prolate), surface, 1);
  });
});

describe("latLonBoxArea", () => {
  // References: the box's area in the WGS 84 cylindrical equal-area projection
  // EPSG:6933 (pyproj 3.8.0), where a box between meridians and parallels is a
  // rectangle, so its area is Δx · Δy.
  it("measures boxes between parallels, including ones wider than 180°", () => {
    // The global box is more than half the ellipsoid, where a ring of geodesics
    // measured with geodesicRingArea would give the smaller side.
    assertClose(latLonBoxArea(9, 45, 10, 46), 8686494956.670462, 1e-3);
    assertClose(latLonBoxArea(-179, 10, 179, 20), 42550157488306.87, 1);
    assertClose(latLonBoxArea(-180, -60, 180, 60), 441233920694280.7, 1);
    // The whole ellipsoid: 510,065,621,724,088.4 m², 4π times the square of
    // WGS 84's authalic radius.
    assertClose(latLonBoxArea(-180, -90, 180, 90), 510065621724088.4, 1);
  });

  it("clamps latitudes and longitude spans, and uses the active body", () => {
    assert.equal(latLonBoxArea(-180, -95, 180, 95), latLonBoxArea(-180, -90, 180, 90));
    assert.equal(latLonBoxArea(-200, 0, 200, 10), latLonBoxArea(-180, 0, 180, 10));
    assert.equal(latLonBoxArea(10, 0, 10, 10), 0);
    // A box with east < west crosses the antimeridian: 179°E to 179°W is 2° wide.
    assert.equal(latLonBoxArea(179, 10, -179, 20), latLonBoxArea(-1, 10, 1, 20));
    // Unwrapped longitudes are wrapped too, never giving a negative area:
    // 200° to -200° is the 320° span from 200° round to 520°.
    assert.equal(latLonBoxArea(200, 10, -200, 20), latLonBoxArea(-160, 10, 160, 20));
    setActiveEllipsoidId("moon");
    // On a sphere: R² Δλ (sin φ₂ − sin φ₁).
    assertClose(
      latLonBoxArea(0, 0, 1, 1),
      1737400 ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180),
      1e-3,
    );
  });
});

describe("isLonLat", () => {
  it("accepts finite positions with |lat| <= 90 and rejects the rest", () => {
    assert.equal(isLonLat([190, 90]), true);
    assert.equal(isLonLat([0, -90]), true);
    assert.equal(isLonLat([0, 90.0001]), false);
    assert.equal(isLonLat([Number.NaN, 0]), false);
    assert.equal(isLonLat([0, Number.POSITIVE_INFINITY]), false);
  });
});
