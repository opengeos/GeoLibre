import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  canExportLidarLayer,
  LIDAR_EXPORT_EXTENSION,
  lidarExportUrl,
} from "../apps/geolibre-desktop/src/lib/lidar-export.ts";

/**
 * A LiDAR store layer as the LiDAR control writes it.
 *
 * @param url - The recorded source URL (`"file"` for a cloud loaded from bytes).
 * @param metadata - Extra metadata, e.g. a retained `localBytesUrl`.
 * @returns The layer.
 */
function lidarLayer(url: string, metadata: Record<string, unknown> = {}): GeoLibreLayer {
  return {
    id: "pc-1",
    name: "Cloud",
    type: "lidar",
    source: { type: "lidar", sourceId: "pc-1", url },
    sourcePath: url,
    visible: true,
    opacity: 1,
    style: {},
    metadata: { sourceKind: "lidar-url", ...metadata },
  } as unknown as GeoLibreLayer;
}

describe("lidarExportUrl", () => {
  it("prefers the retained bytes of a cloud loaded from a file or tool output", () => {
    const layer = lidarLayer("file", { localBytesUrl: "blob:http://localhost/abc" });
    assert.equal(lidarExportUrl(layer), "blob:http://localhost/abc");
  });

  it("reads a single-file cloud from its source URL, including s3://", () => {
    const https = "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";
    assert.equal(lidarExportUrl(lidarLayer(https)), https);
    assert.equal(lidarExportUrl(lidarLayer("s3://bucket/tile.laz")), "s3://bucket/tile.laz");
  });

  it("refuses an Entwine tree and a cloud whose bytes were not kept", () => {
    assert.equal(lidarExportUrl(lidarLayer("https://example.com/ept/ept.json")), null);
    assert.equal(lidarExportUrl(lidarLayer("file")), null);
  });

  it("only applies to LiDAR layers", () => {
    const raster = { ...lidarLayer("https://example.com/dem.tif"), type: "cog" } as GeoLibreLayer;
    assert.equal(canExportLidarLayer(raster), false);
    assert.equal(canExportLidarLayer(lidarLayer("https://example.com/a.las")), true);
  });
});

describe("LIDAR_EXPORT_EXTENSION", () => {
  it("writes COPC as .copc.laz so lidar_convert picks the COPC writer", () => {
    assert.deepEqual(LIDAR_EXPORT_EXTENSION, { las: "las", laz: "laz", copc: "copc.laz" });
  });
});
