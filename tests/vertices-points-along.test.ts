import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, setActiveEllipsoidId, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool } from "@geolibre/processing";
import distance from "@turf/distance";
import type { FeatureCollection, Point, Position } from "geojson";

function makeLayer(id: string, name: string, fc: FeatureCollection): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc,
  };
}

function runTool(
  toolId: string,
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): { messages: string[]; results: FeatureCollection<Point>[] } {
  const tool = getVectorTool(toolId);
  assert.ok(tool, `${toolId} is registered`);
  const messages: string[] = [];
  const results: FeatureCollection<Point>[] = [];
  tool.run({
    layers,
    parameters,
    log: (message) => messages.push(message),
    addResultLayer: (_name, fc) => results.push(fc as FeatureCollection<Point>),
  });
  return { messages, results };
}

describe("extract vertices tool", () => {
  const line = makeLayer("line", "Line", {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "road" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        },
      },
    ],
  });

  it("turns every vertex into a point with vertex/part indices and original attributes", () => {
    const { messages, results } = runTool("extract-vertices", [line], { layer: "line" });
    assert.equal(results.length, 1);
    const fc = results[0];
    assert.equal(fc.features.length, 3);
    assert.deepEqual(
      fc.features.map((f) => f.geometry.coordinates),
      [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    );
    assert.ok(fc.features.every((f) => f.properties?.kind === "road"));
    assert.deepEqual(
      fc.features.map((f) => f.properties?.vertex_index),
      [0, 1, 2],
    );
    assert.ok(fc.features.every((f) => f.properties?.part_index === 0));
    assert.ok(messages.some((m) => m.includes("Extracted 3 vertex point(s)")));
  });

  it("indexes polygon rings as separate parts", () => {
    const polygon = makeLayer("poly", "Poly", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: null,
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
              [
                [0.2, 0.2],
                [0.2, 0.4],
                [0.4, 0.4],
                [0.2, 0.2],
              ],
            ],
          },
        },
      ],
    });
    const { results } = runTool("extract-vertices", [polygon], { layer: "poly" });
    // Outer ring (4 vertices) + hole (4 vertices).
    assert.equal(results[0].features.length, 8);
    assert.equal(results[0].features.filter((f) => f.properties?.part_index === 1).length, 4);
  });

  it("skips geometry-less features and errors on an empty result", () => {
    const mixed = makeLayer("mixed", "Mixed", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: null }, ...line.geojson.features],
    });
    const skipped = runTool("extract-vertices", [mixed], { layer: "mixed" });
    assert.ok(skipped.messages.some((m) => m.includes("Skipped 1")));
    assert.equal(skipped.results[0].features.length, 3);

    const empty = makeLayer("empty", "Empty", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: null }],
    });
    const failed = runTool("extract-vertices", [empty], { layer: "empty" });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.startsWith("Error:")));
  });
});

describe("points along geometry tool", () => {
  // ~111 km per degree of longitude at the equator.
  const line = makeLayer("line", "Line", {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "L1" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [3, 0],
          ],
        },
      },
    ],
  });

  it("places points at the interval plus the endpoint, carrying distance and attributes", () => {
    const { messages, results } = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: 100,
      units: "kilometers",
    });
    assert.equal(results.length, 1);
    const fc = results[0];
    // ~333 km line at a 100 km interval → interior points at 0/100/200/300 km
    // plus the endpoint (the interval never lands exactly on it).
    const total = distance([0, 0], [3, 0], { units: "kilometers" });
    assert.ok(total > 300 && total < 400, `unexpected line length ${total}`);
    assert.equal(fc.features.length, 5);
    const distances = fc.features.map((f) => f.properties?.distance as number);
    assert.equal(distances[0], 0);
    assert.ok(Math.abs(distances[1] - 100) < 0.01);
    assert.ok(Math.abs(distances[2] - 200) < 0.01);
    assert.ok(Math.abs(distances[3] - 300) < 0.01);
    assert.ok(Math.abs(distances[4] - total) < 0.01);
    // x advances monotonically toward the end vertex.
    assert.deepEqual(
      fc.features.map((f) => Math.round(f.geometry.coordinates[0] * 1e6) / 1e6),
      [...distances.map((d) => Math.round((d / total) * 3 * 1e6) / 1e6), 3].slice(0, 5),
    );
    assert.ok(fc.features.every((f) => f.properties?.id === "L1"));
    assert.ok(messages.some((m) => m.includes("Generated 5 point(s) every 100 kilometers")));
  });

  it("does not duplicate the endpoint when the length is an exact multiple", () => {
    // Length is whatever turf says; a half-length interval must land exactly on
    // the endpoint once, without producing a duplicate final point.
    const total = distance([0, 0], [3, 0], { units: "kilometers" });
    const { results } = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: Number((total / 2).toFixed(9)),
      units: "kilometers",
    });
    assert.equal(results[0].features.length, 3);
    assert.equal(results[0].features[2].geometry.coordinates[0], 3);
  });

  it("walks polygon boundaries ring by ring", () => {
    const square = makeLayer("square", "Square", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });
    const { results } = runTool("points-along-geometry", [square], {
      layer: "square",
      interval: 50000,
      units: "meters",
    });
    // ~50 km steps around a ~444 km perimeter → interior points + corners.
    assert.ok(results[0].features.length > 8);
    assert.ok(
      results[0].features.some(
        (f) => f.geometry.coordinates[0] === 0 && f.geometry.coordinates[1] === 0,
      ),
    );
  });

  it("rejects non-positive intervals and non-line input", () => {
    const failed = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: 0,
      units: "kilometers",
    });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.startsWith("Error:")));

    const points = makeLayer("pts", "Pts", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
      ],
    });
    const wrongFamily = runTool("points-along-geometry", [points], {
      layer: "pts",
      interval: 1,
      units: "kilometers",
    });
    assert.equal(wrongFamily.results.length, 0);
    assert.ok(wrongFamily.messages.some((m) => m.includes("no line or polygon features")));
  });

  it("places interval points geodesically so the distance column matches the coordinate", () => {
    // A 90-degree longitude span at 60N: linear lon/lat interpolation puts the
    // midpoint at [45, 60], which is ~53% of the haversine length, not 50%.
    const start: Position = [0, 60];
    const end: Position = [90, 60];
    const arc = makeLayer("arc", "Arc", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [start, end] },
        },
      ],
    });
    const total = distance(start, end, { units: "kilometers" });
    const { results } = runTool("points-along-geometry", [arc], {
      layer: "arc",
      interval: total / 2,
      units: "kilometers",
    });
    const points = results[0].features;
    assert.equal(points.length, 3);
    const mid = points[1];
    assert.equal(mid.properties?.distance, Number((total / 2).toFixed(6)));
    const measured = distance(start, mid.geometry.coordinates, { units: "kilometers" });
    assert.ok(Math.abs(measured / total - 0.5) < 1e-6, `midpoint sits at ${measured / total}`);
    // It does NOT sit on the linear interpolation [45, 60].
    assert.ok(mid.geometry.coordinates[1] > 60.5, `lat ${mid.geometry.coordinates[1]}`);
    assert.deepEqual(points[2].geometry.coordinates, end);
  });

  it("walks a multi-segment line once and carries distance across vertices", () => {
    const poly = makeLayer("poly", "Poly", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
            ],
          },
        },
      ],
    });
    const { results } = runTool("points-along-geometry", [poly], {
      layer: "poly",
      interval: 100,
      units: "kilometers",
    });
    const points = results[0].features;
    assert.deepEqual(
      points.slice(0, 4).map((p) => p.properties?.distance),
      [0, 100, 200, 300],
    );
    assert.equal(points.length, 5);
    assert.deepEqual(points[4].geometry.coordinates, [3, 0]);
    for (const p of points) {
      const measured = distance([0, 0], p.geometry.coordinates, { units: "kilometers" });
      assert.ok(Math.abs(measured - (p.properties?.distance as number)) < 1e-3);
    }
    // Longitudes strictly increase: no vertex was emitted twice.
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i].geometry.coordinates[0] > points[i - 1].geometry.coordinates[0]);
    }
  });

  it("refuses an interval that would generate more points than the hard cap", () => {
    const { messages, results } = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: 0.000001,
      units: "meters",
    });
    assert.equal(results.length, 0);
    assert.match(messages[0], /^Error: this interval would generate about/);
  });

  it("rejects unknown units before touching Turf", () => {
    const { messages, results } = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: 1,
      units: "furlongs",
    });
    assert.equal(results.length, 0);
    assert.equal(messages[0], "Error: unknown units 'furlongs'");
  });

  it("never snaps a point from a previous part when a part is degenerate", () => {
    const multi = makeLayer("multi", "Multi", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [0, 0],
                [0, 0.001],
              ],
              // Every vertex identical: zero length, ends where part 0 ended.
              [
                [0, 0.001],
                [0, 0.001],
              ],
            ],
          },
        },
      ],
    });
    const { results } = runTool("points-along-geometry", [multi], {
      layer: "multi",
      interval: 1,
      units: "kilometers",
    });
    const points = results[0].features;
    // Part 0: start + end. Part 1: its own end vertex only, at distance 0.
    assert.equal(points.length, 3);
    assert.equal(points[1].properties?.distance, Number(distance([0, 0], [0, 0.001]).toFixed(6)));
    assert.equal(points[2].properties?.distance, 0);
  });

  it("scales the interval and distance column by the active body's radius", () => {
    // Mars' mean radius is ~0.53 of Earth's, so a 100 km Mars interval covers
    // ~1.88x the angle a 100 km Earth interval does: fewer points on the same
    // line, and the distance column still reads in Mars kilometres.
    setActiveEllipsoidId("mars");
    try {
      const { results } = runTool("points-along-geometry", [line], {
        layer: "line",
        interval: 100,
        units: "kilometers",
      });
      const points = results[0].features;
      const earthTotal = distance([0, 0], [3, 0], { units: "kilometers" });
      const marsTotal = points[points.length - 1].properties?.distance as number;
      assert.ok(marsTotal < earthTotal * 0.6, `${marsTotal} vs ${earthTotal}`);
      // 0 and 100 km fit; 200 km does not (~177 km on Mars).
      assert.deepEqual(points.map((p) => p.properties?.distance).slice(0, 2), [0, 100]);
      assert.equal(points.length, 3);
    } finally {
      setActiveEllipsoidId("earth");
    }
  });

  it("unwraps GeometryCollection members instead of skipping the feature", () => {
    const collection = makeLayer("gc", "GC", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [
              { type: "Point", coordinates: [5, 5] },
              {
                type: "LineString",
                coordinates: [
                  [0, 0],
                  [1, 0],
                ],
              },
            ],
          },
        },
      ],
    });
    const { messages, results } = runTool("points-along-geometry", [collection], {
      layer: "gc",
      interval: 50,
      units: "kilometers",
    });
    // ~111 km line → 0/50/100 km plus the end vertex; the point member is ignored.
    assert.equal(results[0].features.length, 4);
    assert.ok(!messages.some((m) => m.startsWith("Skipped")));
    const vertices = runTool("extract-vertices", [collection], { layer: "gc" });
    assert.equal(vertices.results[0].features.length, 3);
  });

  it("keeps a sample just past a very long segment's end on the next segment", () => {
    // A ~10,000 km first segment: a boundary tolerance proportional to the
    // segment is a centimetre wide there, so a sample landing millimetres
    // past the shared vertex was snapped back onto it. The interval here puts
    // the second sample 5 mm along the second segment.
    const a: Position = [0, 0];
    const b: Position = [90, 0];
    const c: Position = [90, 10];
    const first = distance(a, b, { units: "kilometers" });
    const interval = first + 0.000005;
    const long = makeLayer("long", "Long", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [a, b, c] },
        },
      ],
    });
    const { results } = runTool("points-along-geometry", [long], {
      layer: "long",
      interval,
      units: "kilometers",
    });
    const points = results[0].features;
    // 0 km, one sample 5 mm up the second segment, then the end vertex.
    assert.equal(points.length, 3);
    const sample = points[1].geometry.coordinates;
    assert.equal(points[1].properties?.distance, Number(interval.toFixed(6)));
    // It sits on the second segment (north of the equator), not snapped back
    // to the shared vertex.
    assert.ok(sample[1] > 0, `latitude ${sample[1]}`);
    const past = distance(b, sample, { units: "kilometers" });
    assert.ok(Math.abs(past - 0.000005) < 1e-6, `${past} km past the vertex`);
  });

  it("interpolates Z on generated points instead of flattening to 2-D", () => {
    const elevated = makeLayer("z", "Z", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0, 100],
              [2, 0, 300],
            ],
          },
        },
      ],
    });
    const total = distance([0, 0], [2, 0], { units: "kilometers" });
    const { results } = runTool("points-along-geometry", [elevated], {
      layer: "z",
      interval: total / 2,
      units: "kilometers",
    });
    const points = results[0].features;
    assert.equal(points.length, 3);
    // Endpoints keep their exact Z; the interior point is interpolated, not
    // dropped to 2-D.
    assert.equal(points[0].geometry.coordinates[2], 100);
    assert.equal(points[2].geometry.coordinates[2], 300);
    const midZ = points[1].geometry.coordinates[2];
    assert.ok(typeof midZ === "number" && Math.abs(midZ - 200) < 1e-6, `mid Z ${midZ}`);
  });
});
