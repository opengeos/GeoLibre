import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  inspectScreenshotLayers,
  screenshotReadinessEnabled,
  type LayerLoadProbe,
} from "../apps/geolibre-desktop/src/lib/screenshot-readiness";

const layer: GeoLibreLayer = {
  id: "nlcd",
  name: "NLCD",
  type: "cog",
  source: {},
  visible: true,
  opacity: 1,
  style: DEFAULT_LAYER_STYLE,
  metadata: { sourceKind: "maplibre-gl-raster" },
};
const map = {
  getZoom: () => 4,
  getLayersOrder: () => ["nlcd"],
  getLayer: () => ({ id: "nlcd", type: "raster", source: "tiles" }),
  getSource: () => ({}),
  isSourceLoaded: () => true,
} as unknown as MapLibreMap;
const probe: LayerLoadProbe = {
  raster: () => ({ loading: false, error: null, native: true, deckTracked: false }),
  deck: () => ({ found: false, loading: false, error: null }),
};

test("screenshot readiness is opt-in, including in map-only embeds", () => {
  for (const value of ["", "=true", "=1", "=yes", "=on", "=TRUE"]) {
    assert.equal(screenshotReadinessEnabled(`?maponly&loading${value}`), true);
  }
  for (const query of ["", "?maponly", "?loading=false", "?loading=0", "?loading=no"]) {
    assert.equal(screenshotReadinessEnabled(query), false);
  }
});

test("an attached native layer cannot mask an unfinished COG header", () => {
  const result = inspectScreenshotLayers(map, [layer], [], {
    ...probe,
    raster: () => ({ loading: true, error: null, native: true, deckTracked: false }),
  });
  assert.deepEqual(result, { pending: ["NLCD"], errors: [] });
});

test("a loaded COG header cannot mask unfinished deck tiles or tile failures", () => {
  assert.deepEqual(
    inspectScreenshotLayers(map, [layer], [], {
      ...probe,
      deck: () => ({ found: true, loading: true, error: null }),
    }),
    { pending: ["NLCD"], errors: [] },
  );
  assert.deepEqual(
    inspectScreenshotLayers(map, [layer], [], {
      ...probe,
      deck: () => ({ found: true, loading: false, error: "Tile request failed" }),
    }),
    { pending: [], errors: ["NLCD: Tile request failed"] },
  );
});

test("a deck-rendered raster waits for the shared overlay only when interleaved", () => {
  // Interleaved (web): the shared deck overlay is the load signal, so a raster
  // it has not registered yet is still pending.
  const interleaved: LayerLoadProbe = {
    ...probe,
    raster: () => ({ loading: false, error: null, native: false, deckTracked: true }),
  };
  assert.deepEqual(inspectScreenshotLayers(map, [layer], [], interleaved), {
    pending: ["NLCD"],
    errors: [],
  });
  // Overlaid (Tauri): a private deck canvas the probe cannot see, so the
  // control's own loaded header is the whole answer -- never pending forever.
  const overlaid: LayerLoadProbe = {
    ...probe,
    raster: () => ({ loading: false, error: null, native: false, deckTracked: false }),
  };
  assert.deepEqual(inspectScreenshotLayers(map, [layer], [], overlaid), {
    pending: [],
    errors: [],
  });
});

test("missing native layers and unfinished native sources remain pending", () => {
  const missing = { ...map, getLayersOrder: () => [] } as unknown as MapLibreMap;
  assert.deepEqual(inspectScreenshotLayers(missing, [layer], [], probe).pending, ["NLCD"]);
  const fetching = { ...map, isSourceLoaded: () => false } as unknown as MapLibreMap;
  assert.deepEqual(inspectScreenshotLayers(fetching, [layer], [], probe).pending, ["NLCD"]);
  assert.deepEqual(inspectScreenshotLayers(map, [layer], [], probe), { pending: [], errors: [] });
});

test("hidden layers do not block a screenshot, unsupported visible renderers fail closed", () => {
  const lidar = { ...layer, type: "lidar" as const, metadata: {} };
  assert.deepEqual(inspectScreenshotLayers(map, [{ ...lidar, visible: false }], [], probe), {
    pending: [],
    errors: [],
  });
  assert.match(
    inspectScreenshotLayers(map, [lidar], [], probe).errors[0],
    /not supported for lidar/,
  );
});

test("a deck-viz layer is probed through the shared overlay, not failed closed", () => {
  const viz = { ...layer, type: "deckgl-viz" as const, metadata: {} };
  assert.deepEqual(
    inspectScreenshotLayers(map, [viz], [], {
      ...probe,
      deck: () => ({ found: true, loading: true, error: null }),
    }),
    { pending: ["NLCD"], errors: [] },
  );
  // Nothing was built for it, so there is no rendering to wait on -- fail
  // closed rather than call an absent layer ready.
  assert.match(
    inspectScreenshotLayers(map, [viz], [], probe).errors[0],
    /no deck\.gl output was built/,
  );
});
