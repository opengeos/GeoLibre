import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { restoreNativeRasterFiles } from "../packages/plugins/src/plugins/native-raster-import";
import { geojsonLayer } from "./helpers/layer-fixtures";

afterEach(() => useAppStore.setState({ layers: [] }));

const localLayer = () =>
  geojsonLayer({
    type: "cog",
    geojson: undefined,
    source: { type: "raster" },
    metadata: { rasterSource: "file", localFilePath: "/data/dem.tif" },
  });

it("retains restored file bytes until the layer is removed and skips already-restored sources", async () => {
  const layer = localLayer();
  useAppStore.setState({ layers: [layer] });
  assert.deepEqual(await restoreNativeRasterFiles(null), [layer.name]);
  assert.equal(useAppStore.getState().layers[0], layer);
  let reads = 0;
  const reader = async (path: string) => {
    reads++;
    assert.equal(path, "/data/dem.tif");
    return new File(["raster bytes"], "dem.tif");
  };
  assert.deepEqual(await restoreNativeRasterFiles(reader), []);
  const restored = useAppStore.getState().layers[0];
  const url = String(restored.metadata.localBytesUrl);
  assert.ok(url.startsWith("blob:"));
  assert.equal(restored.metadata.localFilePath, "/data/dem.tif");
  assert.equal(restored.source.url, undefined);
  assert.equal(await (await fetch(url)).text(), "raster bytes");
  useAppStore.getState().setMapView({ zoom: 8 });
  assert.equal(await (await fetch(url)).text(), "raster bytes");
  await restoreNativeRasterFiles(reader);
  assert.equal(reads, 1);
  useAppStore.getState().removeLayer(layer.id);
  await assert.rejects(fetch(url), /fetch failed/);
});

it("does not overwrite a layer changed while its local file is being read", async () => {
  const layer = localLayer();
  useAppStore.setState({ layers: [layer] });
  let finish!: (file: File) => void;
  const restoring = restoreNativeRasterFiles(
    () =>
      new Promise<File>((resolve) => {
        finish = resolve;
      }),
  );
  useAppStore.getState().updateLayer(layer.id, {
    source: { type: "raster", url: "https://example.test/replacement.tif" },
  });
  finish(new File(["stale bytes"], "dem.tif"));
  await restoring;
  assert.equal(useAppStore.getState().layers[0].source.url, "https://example.test/replacement.tif");
  assert.equal(useAppStore.getState().layers[0].metadata.localBytesUrl, undefined);
});

it("skips remote sources and local layers without a saved path", async () => {
  useAppStore.setState({
    layers: [
      { ...localLayer(), source: { type: "raster", url: "https://example.test/a.tif" } },
      { ...localLayer(), id: "no-path", metadata: { rasterSource: "file" } },
      // A url-less cog that never came from a local file is not reported.
      { ...localLayer(), id: "not-a-file", metadata: {} },
    ],
  });
  let reads = 0;
  const unrestorable = await restoreNativeRasterFiles(async () => {
    reads++;
    return new File([], "unused.tif");
  });
  assert.equal(reads, 0);
  // The path-less local raster has nothing to reload from, so it is reported.
  assert.deepEqual(unrestorable, [localLayer().name]);
  assert.equal(useAppStore.getState().layers.length, 3);
});

it("reports a local raster whose saved file can no longer be read", async () => {
  const layer = localLayer();
  useAppStore.setState({ layers: [layer] });
  const unrestorable = await restoreNativeRasterFiles(async () => {
    throw new Error("missing");
  });
  assert.deepEqual(unrestorable, [layer.name]);
  assert.equal(useAppStore.getState().layers[0].metadata.localBytesUrl, undefined);
});
