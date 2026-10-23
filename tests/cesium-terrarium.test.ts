import assert from "node:assert/strict";
import { it } from "node:test";
import * as Cesium from "@cesium/engine";
import { TerrariumTerrainProvider, terrariumHeightmap } from "../packages/map/src/cesium-terrarium";
function tile(height: number) {
  const data = new Uint8ClampedArray(256 * 256 * 4);
  const value = height + 32768;
  for (let i = 0; i < data.length; i += 4)
    data.set(
      [Math.floor(value / 256), Math.floor(value % 256), Math.round((value % 1) * 256), 255],
      i,
    );
  return data;
}
it("decodes negative and fractional elevations and reads adjacent edge samples", () => {
  const tiles = [tile(-123.25), tile(100), tile(200), tile(300)];
  tiles[0][3] = 0;
  const result = terrariumHeightmap(tiles);
  assert.equal(result[0], 0);
  assert.equal(result[1], -123.25);
  assert.equal(result[64], 100);
  assert.equal(result[64 * 65], 200);
  assert.equal(result[65 * 65 - 1], 300);
  assert.equal(terrariumHeightmap(tiles, true)[64 * 65], -123.25);
});
it("shares edge tile reads, bounds availability, and disposes pending requests", async () => {
  let reads = 0;
  const provider = new TerrariumTerrainProvider(
    Cesium,
    async () => {
      reads++;
      return tile(123);
    },
    2,
  );
  const first = await provider.requestTileGeometry(0, 0, 1);
  assert.ok(first instanceof Cesium.HeightmapTerrainData);
  await provider.requestTileGeometry(1, 0, 1);
  assert.equal(reads, 4);
  assert.equal(provider.getTileDataAvailable(0, 0, 3), false);
  assert.equal(
    provider.availability.computeMaximumLevelAtPosition(Cesium.Cartographic.fromDegrees(0, 0)),
    2,
  );
  const pending = provider.requestTileGeometry(0, 0, 2)!;
  provider.destroy();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(provider.requestTileGeometry(0, 0, 0), undefined);
});
