import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, Position } from "geojson";
import { geodesicDistance } from "../packages/core/src/geodesic";
import {
  EDGE_LENGTH_LAYER_ID,
  EDGE_LENGTH_SOURCE_ID,
  edgeLengthLayer,
  edgeLengthLines,
  formatEdgeLength,
  ringSides,
} from "../packages/map/src/edge-lengths";

/** A square parcel in Lisbon, about 100 m a side, as a closed ring. */
const SQUARE: Position[] = [
  [-9.14, 38.72],
  [-9.13885, 38.72],
  [-9.13885, 38.7209],
  [-9.14, 38.7209],
  [-9.14, 38.72],
];

function polygon(...rings: Position[][]): Feature {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings } };
}

/** Sum of geodesic segment lengths along a path. */
function length(path: Position[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += geodesicDistance(path[i - 1], path[i]);
  return total;
}

/** `count` points on a circle of `radius` degrees around `center`, closed. */
function circle(center: Position, radius: number, count: number): Position[] {
  const ring = Array.from({ length: count }, (_, i): Position => {
    const angle = (2 * Math.PI * i) / count;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
  return [...ring, ring[0]];
}

describe("formatEdgeLength", () => {
  it("uses metres, then kilometres, for the metric scale bar", () => {
    assert.equal(formatEdgeLength(87.345, "metric", "en-US"), "87.3 m");
    assert.equal(formatEdgeLength(1234.5, "metric", "en-US"), "1.23 km");
  });

  it("uses feet, then miles, for the imperial scale bar", () => {
    assert.equal(formatEdgeLength(30.48, "imperial", "en-US"), "100 ft");
    assert.equal(formatEdgeLength(1609.344 * 1.5, "imperial", "en-US"), "1.5 mi");
  });

  it("uses metres, then nautical miles, for the nautical scale bar", () => {
    assert.equal(formatEdgeLength(500, "nautical", "en-US"), "500 m");
    // Metres all the way to a nautical mile, never kilometres.
    assert.equal(formatEdgeLength(1000, "nautical", "en-US"), "1,000 m");
    assert.equal(formatEdgeLength(1500, "nautical", "en-US"), "1,500 m");
    assert.equal(formatEdgeLength(1851, "nautical", "en-US"), "1,851 m");
    assert.equal(formatEdgeLength(1852, "nautical", "en-US"), "1 nmi");
    assert.equal(formatEdgeLength(1852 * 2, "nautical", "en-US"), "2 nmi");
  });

  it("groups digits by the locale", () => {
    assert.equal(formatEdgeLength(1609, "imperial", "de-DE"), "5.278,9 ft");
  });
});

describe("ringSides", () => {
  it("splits a quadrilateral into its four sides", () => {
    const sides = ringSides(SQUARE);
    assert.equal(sides.length, 4);
    for (const side of sides) assert.equal(side.length, 2);
  });

  it("measures a densified straight side once, through its extra vertices", () => {
    const ring: Position[] = [
      [0, 0],
      [0.0005, 0],
      [0.001, 0],
      [0.0015, 0],
      [0.002, 0],
      [0.002, 0.001],
      [0, 0.001],
      [0, 0],
    ];
    const sides = ringSides(ring);
    assert.equal(sides.length, 4);
    assert.deepEqual(sides[0], ring.slice(0, 5));
  });

  it("starts at a corner even when the ring starts partway along a side", () => {
    const ring: Position[] = [
      [0.001, 0],
      [0.002, 0],
      [0.002, 0.001],
      [0, 0.001],
      [0, 0],
      [0.001, 0],
    ];
    const sides = ringSides(ring);
    assert.equal(sides.length, 4);
    // The bottom side runs from the corner at [0, 0] through the old start.
    assert.ok(
      sides.some((side) => side.length === 3 && side[0][0] === 0 && side[0][1] === 0),
      JSON.stringify(sides),
    );
  });

  it("keeps a curved frontage as one side", () => {
    // A square whose top is a gentle arc of 16 segments, each turning ~1.4°.
    const arc = Array.from({ length: 17 }, (_, i): Position => {
      const t = i / 16;
      return [0.002 * (1 - t), 0.002 + 0.0003 * Math.sin(Math.PI * t)];
    });
    const ring: Position[] = [[0, 0], [0.002, 0], ...arc, [0, 0]];
    const sides = ringSides(ring);
    assert.equal(sides.length, 4);
    assert.ok(sides.some((side) => side.length === 17));
  });

  it("separates a straight side from a curve that meets it tangentially", () => {
    // West side north to a quarter arc, tangent at both ends, then the north side east.
    const r = 0.0002;
    const arc = Array.from({ length: 21 }, (_, i): Position => {
      const a = Math.PI - (i * Math.PI) / 2 / 20;
      return [r + r * Math.cos(a), 0.001 + r * Math.sin(a)];
    });
    const ring: Position[] = [[0, 0], ...arc, [0.002, 0.001 + r], [0.002, 0], [0, 0]];
    const sides = ringSides(ring);
    // West side, arc, north side, east side, south side.
    assert.equal(sides.length, 5);
    assert.ok(
      sides.some((side) => side.length === 21),
      "the arc is one side",
    );
  });

  it("keeps a short jog on a straight side as part of the side", () => {
    // A 50 m square at the equator whose bottom side has a 0.5 m stub that
    // turns 1° and back: a digitizing jog, not a curve.
    const s = 0.00045; // ~50 m
    const stub = 0.0000045; // ~0.5 m
    const rise = stub * Math.tan(Math.PI / 180);
    const ring: Position[] = [
      [0, 0],
      [0.0002, 0],
      [0.0002 + stub, rise],
      [s, rise],
      [s, s],
      [0, s],
      [0, 0],
    ];
    assert.equal(ringSides(ring).length, 4);
    // The same with the stub ending at the corner.
    const atCorner: Position[] = [
      [0, 0],
      [s - stub, 0],
      [s, rise],
      [s, s],
      [0, s],
      [0, 0],
    ];
    assert.equal(ringSides(atCorner).length, 4);
  });

  it("keeps a side crossing the antimeridian as one side", () => {
    const ring: Position[] = [
      [179.998, 0],
      [179.999, 0],
      [-180, 0],
      [-179.999, 0],
      [-179.999, 0.001],
      [179.998, 0.001],
      [179.998, 0],
    ];
    const sides = ringSides(ring);
    assert.equal(sides.length, 4);
    // The original coordinates are kept.
    assert.ok(sides.some((side) => side.length === 4 && side[2][0] === -180));
  });

  it("ignores vertices a hair's breadth from the previous one", () => {
    const ring: Position[] = [
      [0, 0],
      [0.001, 0],
      // Float noise on a straight side, and at a corner.
      [0.001 + 1e-10, 1e-10],
      [0.002, 0],
      [0.002, 0.001],
      [0.002 + 1e-10, 0.001 - 1e-10],
      [0, 0.001],
      [0, 0],
    ];
    assert.equal(ringSides(ring).length, 4);
    const { features } = edgeLengthLines([polygon(ring)]);
    assert.ok(features.every((feature) => feature.properties.meters > 1));
  });

  it("keeps unevenly spaced vertices on a straight side as one side", () => {
    const ring: Position[] = [
      [0, 0],
      [0.00001, 0],
      [0.002, 0],
      [0.002, 0.001],
      [0, 0.001],
      [0, 0],
    ];
    assert.equal(ringSides(ring).length, 4);
  });

  it("treats a bend over the threshold as a corner, and a gentler one as part of a side", () => {
    // The bottom edge bends at [0.001, 0] by `degrees`.
    const bent = (degrees: number): Position[] => {
      const rad = (degrees * Math.PI) / 180;
      const end: Position = [0.001 + 0.001 * Math.cos(rad), 0.001 * Math.sin(rad)];
      return [[0, 0], [0.001, 0], end, [end[0], 0.004], [0, 0.004], [0, 0]];
    };
    assert.equal(ringSides(bent(15)).length, 5);
    assert.equal(ringSides(bent(8)).length, 4);
    assert.equal(ringSides(bent(15), 20).length, 4);
  });

  it("measures a ring with no corner as one side, its perimeter", () => {
    const ring = circle([-9.14, 38.72], 0.001, 64);
    const sides = ringSides(ring);
    assert.equal(sides.length, 1);
    assert.equal(sides[0].length, 65);
  });

  it("ignores repeated vertices and degenerate rings", () => {
    const ring: Position[] = [
      SQUARE[0],
      SQUARE[0],
      SQUARE[1],
      SQUARE[2],
      SQUARE[2],
      SQUARE[3],
      SQUARE[0],
    ];
    assert.equal(ringSides(ring).length, 4);
    assert.deepEqual(ringSides([SQUARE[0], SQUARE[1], SQUARE[0]]), []);
  });
});

describe("edgeLengthLines", () => {
  it("labels each side with its geodesic length", () => {
    const { features } = edgeLengthLines([polygon(SQUARE)], { locale: "en-US" });
    assert.equal(features.length, 4);
    for (const feature of features) {
      const coords = feature.geometry.coordinates;
      const meters = length(coords);
      assert.equal(feature.properties.meters, meters);
      assert.equal(feature.properties.label, formatEdgeLength(meters, "metric", "en-US"));
      // About 100 m either way at this latitude.
      assert.ok(meters > 95 && meters < 105, String(meters));
    }
  });

  it("labels in the scale bar's unit system", () => {
    const { features } = edgeLengthLines([polygon(SQUARE)], { unit: "imperial", locale: "en-US" });
    assert.ok(features.every((feature) => feature.properties.label.endsWith(" ft")));
  });

  it("labels the holes and every part of a multipolygon", () => {
    const hole: Position[] = [
      [-9.1395, 38.7202],
      [-9.1395, 38.7205],
      [-9.1392, 38.7205],
      [-9.1392, 38.7202],
      [-9.1395, 38.7202],
    ];
    const shifted = SQUARE.map(([x, y]): Position => [x + 0.01, y]);
    const multi: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: [[SQUARE, hole], [shifted]] },
    };
    assert.equal(edgeLengthLines([multi]).features.length, 12);
  });

  it("skips points, lines, and coordinates that are not longitude/latitude", () => {
    const point: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [-9.14, 38.72] },
    };
    const line: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: SQUARE },
    };
    const projected = polygon(SQUARE.map(([x, y]): Position => [x * 1e5, y * 1e5]));
    assert.deepEqual(edgeLengthLines([point, line, projected]).features, []);
  });

  it("labels nothing rather than part of a selection over the cap", () => {
    assert.equal(edgeLengthLines([polygon(SQUARE)], { maxLabels: 4 }).features.length, 4);
    assert.deepEqual(edgeLengthLines([polygon(SQUARE)], { maxLabels: 3 }).features, []);
  });

  it("bounds dense rings even when they produce only one side", () => {
    const circle = Array.from({ length: 50_000 }, (_, i): Position => {
      const angle = (i * 2 * Math.PI) / 50_000;
      return [-9.14 + 0.001 * Math.cos(angle), 38.72 + 0.001 * Math.sin(angle)];
    });
    circle.push(circle[0]);
    assert.equal(edgeLengthLines([polygon(circle)]).features.length, 0);
  });

  it("counts vertices across all polygon parts before measuring any labels", () => {
    const ring = Array.from({ length: 25_000 }, (_, i) => SQUARE[i % 4]);
    const multipart: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: [[ring], [ring], [SQUARE]] },
    };
    // Side-cap override does not bypass the independent input-work budget.
    assert.equal(edgeLengthLines([multipart], { maxLabels: 100_000 }).features.length, 0);
  });
});

describe("edgeLengthLayer", () => {
  it("centers an upright label on each side, in the style's font", () => {
    const layer = edgeLengthLayer(["Open Sans Regular"]);
    assert.equal(layer.id, EDGE_LENGTH_LAYER_ID);
    assert.equal(layer.source, EDGE_LENGTH_SOURCE_ID);
    assert.equal(layer.layout["symbol-placement"], "line-center");
    assert.equal(layer.layout["text-keep-upright"], true);
    assert.deepEqual(layer.layout["text-font"], ["Open Sans Regular"]);
  });

  it("is hidden from layer lists with the rest of the selection highlight", () => {
    assert.ok(EDGE_LENGTH_LAYER_ID.startsWith("geolibre-highlight-"));
  });
});
