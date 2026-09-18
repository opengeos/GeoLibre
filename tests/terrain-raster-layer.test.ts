import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { terrainRasterLayerOptions } from "../apps/geolibre-desktop/src/lib/terrain-raster-layer";

/** Build the minimum store layer needed by terrain option tests. */
function layer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Elevation",
    type: "cog",
    source: { type: "raster", url: "https://example.com/dem.tif" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    ...overrides,
  };
}

test("terrainRasterLayerOptions includes file-backed raster layers", () => {
  assert.deepEqual(
    terrainRasterLayerOptions([
      layer({}),
      layer({
        id: "local",
        name: "Local DEM",
        source: { type: "raster" },
        metadata: { localBytesUrl: "blob:https://example.com/local-dem" },
      }),
    ]),
    [
      { id: "layer-1", name: "Elevation", source: "https://example.com/dem.tif" },
      { id: "local", name: "Local DEM", source: "blob:https://example.com/local-dem" },
    ],
  );
});

test("terrainRasterLayerOptions excludes vectors and tile-only rasters", () => {
  assert.deepEqual(
    terrainRasterLayerOptions([
      layer({ id: "vector", type: "geojson" }),
      layer({ id: "tiles", type: "raster", source: { type: "raster", tiles: ["x/{z}"] } }),
      layer({
        id: "service",
        type: "raster",
        source: {
          type: "raster",
          url: "https://example.com/wms",
          tiles: ["https://example.com/wms/{z}/{x}/{y}"],
        },
      }),
    ]),
    [],
  );
});
