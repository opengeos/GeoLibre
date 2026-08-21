import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection, Polygon } from "geojson";
import { DEFAULT_LAYER_STYLE, setActiveEllipsoidId } from "@geolibre/core";
import {
  buildGeneratedGeometry,
  buildInvertedMask,
  generatedGeometryKinds,
  lineDecorationColorValue,
} from "../packages/map/src/derived-geometry";

function square(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  properties: Record<string, unknown> = {},
): GeoJSON.Feature<Polygon> {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ],
    },
  };
}

function collection(...features: GeoJSON.Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function pointAt(x: number, y: number): GeoJSON.Feature<GeoJSON.Point> {
  return { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [x, y] } };
}

describe("buildInvertedMask", () => {
  it("produces a world polygon with the features as holes", () => {
    const fc = collection(square(0, 0, 10, 10));
    const mask = buildInvertedMask(fc);
    assert.ok(mask);
    assert.equal(mask.features.length, 1);
    const geometry = mask.features[0].geometry;
    assert.equal(geometry.type, "Polygon");
    // Outer world ring plus one hole for the square.
    assert.equal((geometry as Polygon).coordinates.length, 2);
  });

  it("unions overlapping polygons into a single hole", () => {
    const fc = collection(square(0, 0, 10, 10), square(5, 5, 15, 15));
    const mask = buildInvertedMask(fc);
    assert.ok(mask);
    const geometry = mask.features[0].geometry as Polygon;
    // The two overlapping squares merge into one hole.
    assert.equal(geometry.coordinates.length, 2);
  });

  it("returns null for a collection without polygons", () => {
    const fc = collection({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    assert.equal(buildInvertedMask(fc), null);
  });

  it("memoizes by collection reference", () => {
    const fc = collection(square(0, 0, 10, 10));
    assert.equal(buildInvertedMask(fc), buildInvertedMask(fc));
  });
});

describe("buildGeneratedGeometry", () => {
  it("returns null when the generator is off", () => {
    const fc = collection(square(0, 0, 10, 10));
    assert.equal(buildGeneratedGeometry(fc, "none", 0), null);
  });

  it("derives one centroid per feature, preserving properties", () => {
    const fc = collection(
      square(0, 0, 10, 10, { name: "a" }),
      square(20, 20, 30, 30, { name: "b" }),
    );
    const derived = buildGeneratedGeometry(fc, "centroid", 0);
    assert.ok(derived);
    assert.equal(derived.features.length, 2);
    assert.equal(derived.features[0].geometry.type, "Point");
    assert.deepEqual(derived.features[0].properties, { name: "a" });
    assert.deepEqual(derived.features[1].properties, { name: "b" });
    const [x, y] = (derived.features[0].geometry as GeoJSON.Point).coordinates;
    assert.ok(Math.abs(x - 5) < 1e-6 && Math.abs(y - 5) < 1e-6);
  });

  it("derives bounding boxes for polygons and skips degenerate points", () => {
    const fc = collection(square(0, 0, 10, 10), {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [1, 1] },
    });
    const derived = buildGeneratedGeometry(fc, "bounding-box", 0);
    assert.ok(derived);
    // The point's bbox is degenerate, so only the polygon derives a box.
    assert.equal(derived.features.length, 1);
    assert.equal(derived.features[0].geometry.type, "Polygon");
  });

  it("derives per-feature convex hulls", () => {
    const fc = collection(square(0, 0, 10, 10));
    const derived = buildGeneratedGeometry(fc, "convex-hull", 0);
    assert.ok(derived);
    assert.equal(derived.features.length, 1);
    assert.equal(derived.features[0].geometry.type, "Polygon");
  });

  it("buffers points into polygons using meters", () => {
    const fc = collection({
      type: "Feature",
      properties: { name: "p" },
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    const derived = buildGeneratedGeometry(fc, "buffer", 1000);
    assert.ok(derived);
    assert.equal(derived.features.length, 1);
    assert.equal(derived.features[0].geometry.type, "Polygon");
    // A 1 km buffer around the origin stays within ~0.01 degrees.
    const ring = (derived.features[0].geometry as Polygon).coordinates[0];
    for (const [x, y] of ring) {
      assert.ok(Math.abs(x) < 0.02 && Math.abs(y) < 0.02);
    }
  });

  it("widens a buffer on Mars so it covers the requested Martian metres", () => {
    const fc = collection({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    const earth = buildGeneratedGeometry(fc, "buffer", 100_000);
    setActiveEllipsoidId("mars");
    try {
      const mars = buildGeneratedGeometry(fc, "buffer", 100_000);
      assert.ok(earth && mars);
      const radius = (fcArg: FeatureCollection) =>
        Math.max(
          ...(fcArg.features[0].geometry as Polygon).coordinates[0].map(([x]) => Math.abs(x)),
        );
      // turf lays the buffer out in Earth degrees, so covering 100 km of
      // Martian ground needs ~1.88x the angular radius (issue #1128).
      assert.ok(
        Math.abs(radius(mars) / radius(earth) - 1 / 0.532) < 0.02,
        `expected ~1.88x the angular radius, got ${radius(mars) / radius(earth)}`,
      );
    } finally {
      setActiveEllipsoidId("earth");
    }
  });

  it("returns an empty collection for a zero buffer distance", () => {
    const fc = collection(square(0, 0, 10, 10));
    const derived = buildGeneratedGeometry(fc, "buffer", 0);
    assert.ok(derived);
    assert.equal(derived.features.length, 0);
  });

  it("buffers each feature by its own attribute value", () => {
    const fc = collection(
      { ...pointAt(0, 0), properties: { radius: 1000 } },
      { ...pointAt(10, 0), properties: { radius: 5000 } },
    );
    const derived = buildGeneratedGeometry(fc, "buffer", 1000, "radius");
    assert.ok(derived);
    assert.equal(derived.features.length, 2);
    // The 5 km buffer must come out about five times wider than the 1 km one.
    const widths = derived.features.map((feature) => {
      const xs = (feature.geometry as Polygon).coordinates[0].map(([x]) => x);
      return Math.max(...xs) - Math.min(...xs);
    });
    assert.ok(widths[1] / widths[0] > 4.5 && widths[1] / widths[0] < 5.5);
  });

  it("falls back to the flat distance for missing or non-numeric values", () => {
    const fc = collection(
      { ...pointAt(0, 0), properties: { radius: null } },
      { ...pointAt(10, 0), properties: { radius: "wide" } },
      { ...pointAt(20, 0), properties: {} },
      // A blank string coerces to 0 via Number(""), so it must read as a
      // missing value rather than a real zero-distance buffer. Number() trims
      // first, so a whitespace-only value is the same case.
      { ...pointAt(30, 0), properties: { radius: "" } },
      { ...pointAt(40, 0), properties: { radius: "  " } },
      // Number() would turn these into a 1 m and a 1 km buffer respectively,
      // but neither is a distance. Both differ from the flat distance below,
      // so a regression to a bare Number(raw) shows up as a width.
      { ...pointAt(50, 0), properties: { radius: true } },
      { ...pointAt(60, 0), properties: { radius: [1000] } },
      { ...pointAt(70, 0), properties: { radius: Number.NaN } },
      // Numeric strings are honored, matching the numeric-field pickers. Kept
      // different from the flat distance so the assertion below can tell a
      // parsed value apart from a fallback.
      { ...pointAt(80, 0), properties: { radius: "2000" } },
    );
    const derived = buildGeneratedGeometry(fc, "buffer", 3000, "radius");
    assert.ok(derived);
    assert.equal(derived.features.length, 9);
    const widths = derived.features.map((feature) => {
      const xs = (feature.geometry as Polygon).coordinates[0].map(([x]) => x);
      return Math.max(...xs) - Math.min(...xs);
    });
    // Every unreadable value ends up on the same 3 km fallback...
    const [fallbackWidth, ...rest] = widths.slice(0, 8);
    for (const width of rest) {
      assert.ok(Math.abs(width - fallbackWidth) < 1e-6);
    }
    // ...while the numeric string is parsed, not fallen back to.
    const ratio = widths[8] / fallbackWidth;
    assert.ok(ratio > 0.6 && ratio < 0.73);
  });

  it("skips features whose buffer field resolves to zero", () => {
    const fc = collection(
      { ...pointAt(0, 0), properties: { radius: 0 } },
      { ...pointAt(10, 0), properties: { radius: 1000 } },
    );
    const derived = buildGeneratedGeometry(fc, "buffer", 1000, "radius");
    assert.ok(derived);
    // A zero-distance turf buffer returns the source geometry, which would
    // draw the untouched feature as if it were its own buffer.
    assert.equal(derived.features.length, 1);
  });

  it("still derives buffers when only the field supplies a distance", () => {
    const fc = collection({ ...pointAt(0, 0), properties: { radius: 1000 } });
    // A zero flat distance short-circuits to an empty collection without a
    // field, but with one it is only the fallback.
    assert.equal(buildGeneratedGeometry(fc, "buffer", 0)?.features.length, 0);
    assert.equal(buildGeneratedGeometry(fc, "buffer", 0, "radius")?.features.length, 1);
  });

  it("caches buffer variants per field", () => {
    const fc = collection({ ...pointAt(0, 0), properties: { radius: 1000, wide: 5000 } });
    assert.equal(
      buildGeneratedGeometry(fc, "buffer", 1000, "radius"),
      buildGeneratedGeometry(fc, "buffer", 1000, "radius"),
    );
    assert.notEqual(
      buildGeneratedGeometry(fc, "buffer", 1000, "radius"),
      buildGeneratedGeometry(fc, "buffer", 1000, "wide"),
    );
  });

  it("memoizes per collection and parameters", () => {
    const fc = collection(square(0, 0, 10, 10));
    assert.equal(
      buildGeneratedGeometry(fc, "centroid", 0),
      buildGeneratedGeometry(fc, "centroid", 0),
    );
    assert.notEqual(
      buildGeneratedGeometry(fc, "centroid", 0),
      buildGeneratedGeometry(fc, "convex-hull", 0),
    );
  });

  it("caps cached generator variants per collection (oldest evicted)", () => {
    const fc = collection(square(0, 0, 10, 10));
    const first = buildGeneratedGeometry(fc, "buffer", 1);
    // Fill the 8-entry cache past its cap with distinct buffer distances.
    for (let distance = 2; distance <= 9; distance += 1) {
      buildGeneratedGeometry(fc, "buffer", distance);
    }
    // The oldest entry (distance 1) was evicted, so it recomputes...
    assert.notEqual(buildGeneratedGeometry(fc, "buffer", 1), first);
    // ...while the newest entry is still cached.
    assert.equal(buildGeneratedGeometry(fc, "buffer", 9), buildGeneratedGeometry(fc, "buffer", 9));
  });

  it("normalizes 3D bounding boxes to their 2D corners", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0, 100],
              [10, 5, 200],
            ],
          },
        },
      ],
    };
    const derived = buildGeneratedGeometry(fc, "bounding-box", 0);
    assert.ok(derived);
    assert.equal(derived.features.length, 1);
    const ring = (derived.features[0].geometry as Polygon).coordinates[0];
    const xs = ring.map(([x]) => x);
    const ys = ring.map(([, y]) => y);
    // The Z values (100/200) must not leak into the planar bounds.
    assert.deepEqual(
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      [0, 0, 10, 5],
    );
  });
});

describe("generatedGeometryKinds", () => {
  it("reports the geometry kinds present", () => {
    const derived = collection(square(0, 0, 1, 1), {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    assert.deepEqual(generatedGeometryKinds(derived), {
      hasPoint: true,
      hasPolygon: true,
    });
    assert.deepEqual(generatedGeometryKinds(collection()), {
      hasPoint: false,
      hasPolygon: false,
    });
  });
});

describe("lineDecorationColorValue", () => {
  it("inherits the stroke color when unset", () => {
    const style = { ...DEFAULT_LAYER_STYLE, strokeColor: "#123456" };
    assert.equal(lineDecorationColorValue(style), "#123456");
  });

  it("uses the explicit decoration color when set", () => {
    const style = {
      ...DEFAULT_LAYER_STYLE,
      strokeColor: "#123456",
      lineDecorationColor: "#ff0000",
    };
    assert.equal(lineDecorationColorValue(style), "#ff0000");
  });
});
