import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCogElevationLayer } from "../packages/map/src/arcgis-cog-terrain";
import { encodeTerrariumDem } from "../packages/map/src/cog-dem-source";
import type { ArcgisSceneSdk } from "../packages/map/src/arcgis-sdk";

function fakeScene(): ArcgisSceneSdk {
  return {
    BaseElevationLayer: {
      createSubclass: (definition: Record<string, unknown>) => {
        class Elevation {
          constructor(props: object) {
            Object.assign(this, props);
          }
        }
        Object.assign(Elevation.prototype, definition);
        return Elevation;
      },
    },
  } as unknown as ArcgisSceneSdk;
}

describe("ArcGIS COG elevation vertices", () => {
  it("decodes elevations and gives adjacent meshes identical boundary heights", async () => {
    let reads = 0;
    const layer = createCogElevationLayer(
      fakeScene(),
      {
        tiles: ["unused"],
        dispose() {},
        renderTile: async (_z, x, y) => {
          reads++;
          return encodeTerrariumDem(
            Float32Array.from(
              { length: 256 * 256 },
              (_, i) => 2 * (x * 256 + (i % 256)) + y * 256 + Math.floor(i / 256),
            ),
            null,
          );
        },
      },
      2,
    );
    const left = await layer.fetchTile(3, 2, 2);
    const right = await layer.fetchTile(3, 2, 3);
    assert.equal(left.width, 257);
    assert.equal(left.height, 257);
    assert.equal(left.values[10 * 257 + 20], (2 * (512 + 19.5) + 512 + 9.5) * 2);
    for (let row = 0; row < 257; row++)
      assert.equal(left.values[row * 257 + 256], right.values[row * 257]);
    assert.equal(reads, 12, "neighbouring requests reuse six decoded tile reads");
  });
  it("uses zero outside the north and south world boundaries", async () => {
    const layer = createCogElevationLayer(
      fakeScene(),
      {
        tiles: ["unused"],
        dispose() {},
        renderTile: async (_z, _x, y) => {
          assert.ok(y >= 0 && y < 2);
          return encodeTerrariumDem(new Float32Array(256 * 256).fill(100), null);
        },
      },
      1,
    );
    const north = await layer.fetchTile(1, 0, 0);
    const south = await layer.fetchTile(1, 1, 0);
    assert.equal(north.values[100], 50);
    assert.equal(north.values[257 + 100], 100);
    assert.equal(south.values[256 * 257 + 100], 50);
  });
  it("checks cancellation before scheduling DEM reads", async () => {
    let reads = 0;
    const layer = createCogElevationLayer(
      fakeScene(),
      {
        tiles: ["unused"],
        dispose() {},
        renderTile: async () => {
          reads++;
          return new Uint8ClampedArray(256 * 256 * 4);
        },
      },
      1,
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(layer.fetchTile(1, 0, 0, { signal: abort.signal }), {
      name: "AbortError",
    });
    assert.equal(reads, 0);
  });
});
