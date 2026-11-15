import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useAppStore } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";
import { geojsonLayer } from "./helpers/layer-fixtures";

const map = {} as MapLibreMap;
afterEach(() => {
  mock.restoreAll();
  useAppStore.setState({ layers: [] });
});

it("resolves GCS before fetching remote GeoJSON", async () => {
  const data = { type: "FeatureCollection", features: [] };
  const fetcher = mock.method(globalThis, "fetch", async (_input: RequestInfo | URL) =>
    Response.json(data),
  );
  const layer = geojsonLayer({ geojson: undefined, source: { url: " GS://bucket/data.json " } });
  useAppStore.setState({ layers: [layer] });
  syncLayer(map, layer);
  syncLayer(map, layer);
  await setImmediate();
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(
    fetcher.mock.calls[0].arguments[0],
    "https://storage.googleapis.com/bucket/data.json",
  );
  assert.deepEqual(useAppStore.getState().layers[0].geojson, data);
});

it("rejects error responses and malformed GeoJSON without retrying every sync", async () => {
  for (const response of [
    Response.json({ error: "unavailable" }, { status: 503 }),
    Response.json({ type: "FeatureCollection", features: [null] }),
    Response.json({ type: "FeatureCollection", features: {} }),
  ]) {
    const fetcher = mock.method(globalThis, "fetch", async () => response);
    mock.method(console, "warn", () => {});
    const layer = geojsonLayer({
      geojson: undefined,
      source: { url: "https://example.com/data.json" },
    });
    useAppStore.setState({ layers: [layer] });
    syncLayer(map, layer);
    await setImmediate();
    syncLayer(map, layer);
    await setImmediate();
    assert.equal(fetcher.mock.callCount(), 1);
    assert.equal(useAppStore.getState().layers[0].geojson, undefined);
    mock.restoreAll();
  }
});

it("ignores a response after the source changes or the layer is removed", async () => {
  for (const remove of [false, true]) {
    let finish!: (response: Response) => void;
    mock.method(
      globalThis,
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const layer = geojsonLayer({
      geojson: undefined,
      source: { url: "https://example.com/old.json" },
    });
    useAppStore.setState({ layers: [layer] });
    syncLayer(map, layer);
    await setImmediate();
    if (remove) useAppStore.setState({ layers: [] });
    else
      useAppStore
        .getState()
        .updateLayer(layer.id, { source: { url: "https://example.com/new.json" } });
    finish(Response.json({ type: "FeatureCollection", features: [] }));
    await setImmediate();
    assert.equal(useAppStore.getState().layers[0]?.geojson, undefined);
    mock.restoreAll();
  }
});
