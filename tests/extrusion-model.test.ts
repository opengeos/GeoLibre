import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import {
  buildExtrusionModel,
  encodeGlb,
  encodeObj,
  encodeStl,
  type ExtrudedSolid,
} from "../apps/geolibre-desktop/src/lib/extrusion-model";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return {
    ...DEFAULT_LAYER_STYLE,
    extrusionEnabled: true,
    extrusionHeightProperty: "height",
    extrusionHeightScale: 1,
    extrusionBase: 0,
    extrusionColor: "#ff0000",
    ...patch,
  };
}

// A ~11 m square near the equator, optionally with a centred hole.
function square(height: unknown, withHole = false, extra: Record<string, unknown> = {}): Feature {
  const outer = [
    [0, 0],
    [0.0001, 0],
    [0.0001, 0.0001],
    [0, 0.0001],
    [0, 0],
  ];
  const hole = [
    [0.00003, 0.00003],
    [0.00007, 0.00003],
    [0.00007, 0.00007],
    [0.00003, 0.00007],
    [0.00003, 0.00003],
  ];
  return {
    type: "Feature",
    properties: { height, ...extra },
    geometry: { type: "Polygon", coordinates: withHole ? [outer, hole] : [outer] },
  };
}

function collection(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** Signed volume by the divergence theorem; positive for an outward-facing closed mesh. */
function volume(solid: ExtrudedSolid): number {
  const p = solid.positions;
  let sum = 0;
  for (let t = 0; t < solid.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => solid.indices[t + k] * 3);
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

/** Every undirected edge of a closed surface is shared by exactly two triangles. */
function isClosed(solid: ExtrudedSolid): boolean {
  const key = (i: number) => [0, 1, 2].map((k) => solid.positions[i * 3 + k].toFixed(6)).join(",");
  const edges = new Map<string, number>();
  for (let t = 0; t < solid.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(solid.indices[t + e]);
      const b = key(solid.indices[t + ((e + 1) % 3)]);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((count) => count === 2);
}

describe("buildExtrusionModel", () => {
  it("builds a closed, outward-facing solid with the painted height", () => {
    const model = buildExtrusionModel(collection(square(20)), style());
    assert.equal(model.solids.length, 1);
    const [solid] = model.solids;
    assert.ok(isClosed(solid));
    const zs = solid.positions.filter((_, i) => i % 3 === 2);
    assert.equal(Math.min(...zs), 0);
    assert.equal(Math.max(...zs), 20);
    // ~11.13 m x ~11.13 m x 20 m.
    assert.ok(Math.abs(volume(solid) - 11.132 * 11.132 * 20) < 5, `volume ${volume(solid)}`);
  });

  it("cuts holes and keeps the solid closed whatever the input winding", () => {
    const feature = square(10, true);
    if (feature.geometry.type === "Polygon") {
      feature.geometry.coordinates = feature.geometry.coordinates.map((ring) =>
        [...ring].reverse(),
      );
    }
    const [solid] = buildExtrusionModel(collection(feature), style()).solids;
    assert.ok(isClosed(solid));
    const expected = (11.132 * 11.132 - 4.453 * 4.453) * 10;
    assert.ok(Math.abs(volume(solid) - expected) < 5, `volume ${volume(solid)}`);
  });

  it("honours the base, the colour expression and skips flat features", () => {
    const model = buildExtrusionModel(
      collection(square(30, false, { kind: "a" }), square(5, false, { kind: "b" })),
      style({
        extrusionBase: 10,
        extrusionAdvancedStyleEnabled: true,
        extrusionColorExpression: JSON.stringify([
          "match",
          ["get", "kind"],
          "a",
          "#00ff00",
          "#0000ff",
        ]),
      }),
    );
    assert.equal(model.solids.length, 1);
    assert.equal(model.skipped, 1);
    const zs = model.solids[0].positions.filter((_, i) => i % 3 === 2);
    assert.equal(Math.min(...zs), 10);
    assert.deepEqual(model.solids[0].color, [0, 1, 0]);
  });

  it("ignores non-polygon features and names solids", () => {
    const point: Feature = {
      type: "Feature",
      properties: { height: 5 },
      geometry: { type: "Point", coordinates: [0, 0] },
    };
    const model = buildExtrusionModel(
      collection(point, square(8, false, { name: "Town Hall" })),
      style(),
    );
    assert.equal(model.solids.length, 1);
    assert.equal(model.solids[0].name, "Town Hall");
  });
});

describe("buildExtrusionModel across the antimeridian", () => {
  it("keeps a polygon straddling ±180° compact and centred on it", () => {
    const feature: Feature = {
      type: "Feature",
      properties: { height: 10 },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [179.9999, 0],
              [180, 0],
              [180, 0.0001],
              [179.9999, 0.0001],
              [179.9999, 0],
            ],
          ],
          [
            [
              [-180, 0],
              [-179.9999, 0],
              [-179.9999, 0.0001],
              [-180, 0.0001],
              [-180, 0],
            ],
          ],
        ],
      },
    };
    const model = buildExtrusionModel(collection(feature), style());
    assert.ok(Math.abs(Math.abs(model.origin[0]) - 180) < 1e-9, `origin ${model.origin[0]}`);
    const xs = model.solids[0].positions.filter((_, i) => i % 3 === 0);
    // ~22 m wide, not ~40,000 km.
    assert.ok(Math.max(...xs) - Math.min(...xs) < 30);
  });

  it("counts features with no extrudable area as skipped", () => {
    const sliver: Feature = {
      type: "Feature",
      properties: { height: 10 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [2, 0],
            [0, 0],
          ],
        ],
      },
    };
    const model = buildExtrusionModel(collection(sliver, square(5)), style());
    assert.equal(model.solids.length, 1);
    assert.equal(model.skipped, 1);
  });
});

describe("model encoders", () => {
  const model = buildExtrusionModel(
    collection(square(20, false, { name: "A b#c" }), square(12, true)),
    style(),
  );

  it("writes a well-formed GLB", () => {
    const glb = encodeGlb(model, "Buildings");
    const view = new DataView(glb.buffer);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(8, true), glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    assert.equal(jsonLength % 4, 0);
    const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    assert.equal(gltf.meshes.length, 2);
    assert.equal(gltf.nodes.at(-1).name, "Buildings");
    assert.equal(gltf.nodes[0].extras.name, "A b#c");
    const binLength = view.getUint32(20 + jsonLength, true);
    assert.equal(binLength, gltf.buffers[0].byteLength);
    assert.equal(binLength % 4, 0);
    // Y-up: the 20 m roof is the position accessor's max y.
    assert.ok(Math.abs(gltf.accessors[0].max[1] - 20) < 1e-6);
    for (const accessor of gltf.accessors) {
      const bufferView = gltf.bufferViews[accessor.bufferView];
      const size = accessor.type === "VEC3" ? 12 : 4;
      assert.ok(accessor.byteOffset + accessor.count * size <= bufferView.byteLength);
    }
  });

  it("writes OBJ objects and faces with vertex colours", () => {
    const obj = encodeObj(model, "Buildings");
    assert.match(obj, /^o A_b_c$/m);
    assert.match(obj, /^v \S+ \S+ \S+ 1\.0000 0 0$/m);
    const vertexCount = obj.match(/^v /gm)?.length ?? 0;
    const faces = obj.match(/^f .*$/gm) ?? [];
    const maxIndex = Math.max(...faces.flatMap((f) => f.match(/\d+(?=\/\/)/g)!.map(Number)));
    assert.equal(maxIndex, vertexCount);
  });

  it("writes a binary STL sized by its triangle count", () => {
    const stl = encodeStl(model);
    const triangles = model.solids.reduce((sum, s) => sum + s.indices.length / 3, 0);
    assert.equal(new DataView(stl.buffer).getUint32(80, true), triangles);
    assert.equal(stl.byteLength, 84 + triangles * 50);
  });
});
