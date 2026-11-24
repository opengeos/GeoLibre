import assert from "node:assert/strict";
import { it } from "node:test";
import {
  threeDTilesRootBounds,
  loadThreeDTilesBounds,
} from "../packages/plugins/src/plugins/three-d-tiles-bounds";
import { addThreeDTilesLayerFromUrl } from "../packages/plugins/src/plugins/maplibre-3d-tiles";
import { getLayerBounds } from "../packages/map/src/geojson-loader";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

it("keeps regions geographic and unwraps their dateline crossing", () => {
  const radians = Math.PI / 180;
  const result = threeDTilesRootBounds({
    root: {
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9999, 9999, 0, 1],
      boundingVolume: {
        region: [170 * radians, -5 * radians, -170 * radians, 5 * radians, 0, 100],
      },
    },
  });
  assert.ok(result);
  for (const [index, expected] of [170, -5, 190, 5].entries())
    assert.ok(Math.abs(result[index] - expected) < 1e-9);
});

it("transforms a local box into an enclosing geographic camera extent", () => {
  const result = threeDTilesRootBounds({
    root: {
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 6378137, 0, 0, 1],
      boundingVolume: { box: [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100] },
    },
  });
  assert.ok(result);
  assert.ok(result[0] < -0.00089 && result[2] > 0.00089);
  assert.ok(result[1] < -0.00089 && result[3] > 0.00089);
  assert.ok(result[2] - result[0] < 0.01);
});

it("rejects malformed volumes and treats a sphere at the Earth centre as global", () => {
  assert.equal(threeDTilesRootBounds({ root: { boundingVolume: { sphere: [0, 0, 0] } } }), null);
  assert.deepEqual(
    threeDTilesRootBounds({ root: { boundingVolume: { sphere: [0, 0, 0, 6378137] } } }),
    [-180, -90, 180, 90],
  );
});

it("makes a batch tileset available to the shared extent calculation before returning", async (t) => {
  const previous = useAppStore.getState().layers;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          root: {
            boundingVolume: { region: [0.1, 0.2, 0.3, 0.4, 0, 100] },
          },
        }),
      ),
  );
  try {
    const id = await addThreeDTilesLayerFromUrl(
      { getMapRenderer: () => "cesium" } as GeoLibreAppAPI,
      "https://example.com/tileset.json",
      { flyTo: false },
    );
    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer);
    const bounds = getLayerBounds(layer);
    assert.ok(bounds && bounds[0] > 5 && bounds[2] > 17);
  } finally {
    useAppStore.setState({ layers: previous });
  }
});

it("rejects a failed metadata read without adding a loading record", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(loadThreeDTilesBounds("https://example.com/tileset.json"), /HTTP 503/);
});
