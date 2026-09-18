import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as C from "@cesium/engine";
import { cesiumProfileMap } from "../packages/plugins/src/plugins/elevation-profile/cesium";

function makeHandle() {
  const calls: string[] = [];
  const provider = { availability: {} };
  const viewer = {
    entities: new C.EntityCollection(),
    isDestroyed: () => false,
    terrainProvider: provider,
  };
  const sample = async (terrain: unknown, positions: C.Cartographic[]) => {
    assert.equal(terrain, viewer.terrainProvider);
    return positions.map((point, i) => {
      point.height = 100 + i * 30;
      return point;
    });
  };
  const handle = {
    Cesium: {
      ...C,
      sampleTerrainMostDetailed: (...args: Parameters<typeof sample>) => {
        calls.push("detailed");
        return sample(...args);
      },
      sampleTerrain: (terrain: unknown, level: number, points: C.Cartographic[]) => {
        calls.push(`level:${level}`);
        return sample(terrain, points);
      },
    },
    viewer,
    requestRender() {},
  };
  return { handle, viewer, calls };
}

describe("Cesium elevation profiles", () => {
  it("samples the active terrain at its most detailed level in unexaggerated metres", async () => {
    const { handle, calls } = makeHandle();
    const profile = cesiumProfileMap(handle as never);
    assert.deepEqual(
      await profile.sample([
        [10, 20],
        [10.1, 20.1],
      ]),
      [100, 130],
    );
    assert.deepEqual(calls, ["detailed"]);
  });
  it("uses a bounded level for terrain providers without availability metadata", async () => {
    const { handle, viewer, calls } = makeHandle();
    viewer.terrainProvider = {} as never;
    assert.deepEqual(await cesiumProfileMap(handle as never).sample([[10, 20]]), [100]);
    assert.deepEqual(calls, ["level:14"]);
  });
  it("draws native geometry, keeps unrelated entities, and fits across the antimeridian", () => {
    const { handle, viewer } = makeHandle();
    viewer.entities.add({ id: "unrelated" });
    let bounds: number[] = [];
    const profile = cesiumProfileMap(handle as never, (value) => {
      bounds = value;
    });
    profile.setLine([
      [179, 10],
      [-179, 11],
    ]);
    profile.setHover([179, 10]);
    assert.equal(viewer.entities.values.length, 3);
    profile.fit([
      [179, 10],
      [-179, 11],
    ]);
    assert.ok(bounds[2] - bounds[0] < 3);
    profile.clear();
    assert.deepEqual(
      viewer.entities.values.map((entity) => entity.id),
      ["unrelated"],
    );
  });
  it("rejects a sample if its terrain source changed during the request", async () => {
    const { handle, viewer } = makeHandle();
    let finish!: (points: C.Cartographic[]) => void;
    handle.Cesium.sampleTerrainMostDetailed = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const request = cesiumProfileMap(handle as never).sample([[10, 20]]);
    viewer.terrainProvider = { availability: {} };
    finish([C.Cartographic.fromDegrees(10, 20, 100)]);
    await assert.rejects(request, /terrain source changed/);
  });
});
