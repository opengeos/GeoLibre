import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, parseProject, type GeoLibreLayer } from "@geolibre/core";
import { writeArrayBuffer } from "geotiff";
import { previewI18n } from "../apps/geolibre-mcp-app/src/preview-i18n";
import {
  cogCorners,
  cogEpsg,
  cogPreviewStyle,
  colorizeBands,
  colormapLut,
  loadCogPreview,
  pickPreviewImage,
  previewSize,
  resampleToMercatorRows,
} from "../apps/geolibre-mcp-app/src/cog-preview";
import {
  createNetworkConsent,
  MAX_RANGE_BYTES,
  type NetworkConsent,
  type PreviewToolTransport,
} from "../apps/geolibre-mcp-app/src/network-consent";
import {
  ConsentPMTilesSource,
  isRegisteredPMTilesRequest,
  pmtilesArchiveKey,
  pmtilesArchiveUrl,
  previewPMTilesStyleLayerIds,
} from "../apps/geolibre-mcp-app/src/pmtiles-preview";
import {
  previewOrigins,
  previewRenderLayers,
  unsupportedContent,
} from "../apps/geolibre-mcp-app/src/unsupported-content";
import "./helpers/dom";
import { styleLayerZoomRange, identifyStyleLayerIds } from "@geolibre/map/headless";

function layer(type: GeoLibreLayer["type"], extra: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: type,
    name: type,
    type,
    visible: true,
    opacity: 1,
    source: {
      type: "raster",
      tiles: ["https://maps.example.com/{z}/{x}/{y}.png"],
    },
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...extra,
  };
}

/** A PMTiles layer shaped like the Python `pmtiles_layer` builder writes it. */
function pmtilesLayer(id: string, url: string): GeoLibreLayer {
  return layer("pmtiles", {
    id,
    name: id,
    source: {
      type: "vector",
      url,
      sourceId: id,
      sourceLayers: ["roads"],
      tileType: "vector",
    },
    sourcePath: url,
    metadata: {
      sourceKind: "pmtiles-url",
      externalNativeLayer: true,
      sourceId: id,
      tileType: "vector",
      sourceLayers: ["roads"],
      nativeLayerIds: [id],
    },
  });
}

/** A COG layer shaped like the Python `cog_layer` builder writes it. */
function cogLayer(
  id: string,
  url: string,
  rasterState: Record<string, unknown> = {},
): GeoLibreLayer {
  return layer("cog", {
    id,
    name: id,
    source: { type: "raster", url },
    sourcePath: url,
    metadata: {
      customLayerType: "raster",
      externalDeckLayer: true,
      externalNativeLayer: true,
      rasterSource: "url",
      rasterState,
      sourceKind: "maplibre-gl-raster",
    },
  });
}

function project(layers: GeoLibreLayer[]) {
  return parseProject(
    JSON.stringify({
      version: "0.2.0",
      name: "Preview",
      mapView: { center: [0, 0], zoom: 3 },
      layers,
    }),
  );
}

describe("MCP preview PMTiles and COG classification", () => {
  it("classifies a COG by its resolved remote fallback", () => {
    const archive = cogLayer("fallback-cog", "file:///missing.tif");
    archive.sourcePath = "https://cogs.example.com/dem.tif";
    const saved = project([archive]);
    assert.equal(previewRenderLayers(saved)[0].kind, "cog");
    assert.ok(!unsupportedContent(saved).join("\n").includes("desktop-local"));
  });
  it("uses a validated sourcePath fallback for both sync and archive registration", () => {
    const archive = pmtilesLayer("fallback", "file:///missing.pmtiles");
    archive.sourcePath = "https://tiles.example.com/fallback.pmtiles";
    const [planned] = previewRenderLayers(project([archive]));
    assert.equal(planned.kind, "pmtiles");
    assert.equal(planned.layer.source.url, archive.sourcePath);
    assert.equal(pmtilesArchiveKey(planned.layer), archive.sourcePath);
    assert.equal(pmtilesArchiveUrl(planned.layer), archive.sourcePath);
    assert.equal(archive.source.url, "file:///missing.pmtiles");
  });
  it("includes realized vector IDs for Identify while retaining saved control IDs", () => {
    const archive = pmtilesLayer("roads", "https://example.com/a.pmtiles");
    archive.metadata.nativeLayerIds = ["roads", "saved-control-line"];
    const ids = new Set([
      ...identifyStyleLayerIds(archive),
      ...previewPMTilesStyleLayerIds(archive),
    ]);
    assert.ok(ids.has("roads-roads-fill"));
    assert.ok(ids.has("roads-roads-line"));
    assert.ok(ids.has("roads-roads-circle"));
    assert.ok(ids.has("saved-control-line"));
  });

  it("reports vector archives missing source-layer metadata while accepting rasters", () => {
    const empty = pmtilesLayer("empty", "https://example.com/a.pmtiles");
    empty.source.sourceLayers = [];
    empty.metadata.sourceLayers = [];
    const raster = pmtilesLayer("raster", "https://example.com/b.pmtiles");
    raster.source = { ...raster.source, type: "raster", sourceLayers: [] };
    raster.metadata = { ...raster.metadata, tileType: "raster", sourceLayers: [] };
    const saved = project([empty, raster]);
    assert.deepEqual(
      previewRenderLayers(saved).map(({ layer: item }) => item.id),
      ["raster"],
    );
    assert.ok(unsupportedContent(saved).some((notice) => notice.includes("“empty”")));
  });
  it("draws remote archives and COGs in project order and asks consent for their origins", () => {
    const saved = project([
      cogLayer("dem", "https://cogs.example.com/dem.tif"),
      layer("xyz", { id: "streets" }),
      pmtilesLayer("roads", "pmtiles://https://tiles.example.com/roads.pmtiles"),
    ]);
    assert.deepEqual(
      previewRenderLayers(saved).map(({ layer: item, kind }) => [item.id, kind]),
      [
        ["dem", "cog"],
        ["streets", "native"],
        ["roads", "pmtiles"],
      ],
    );
    const origins = previewOrigins(saved);
    for (const origin of [
      "https://cogs.example.com",
      "https://maps.example.com",
      "https://tiles.example.com",
    ]) {
      assert.ok(origins.includes(origin), origin);
    }
    const notices = unsupportedContent(saved).join("\n");
    assert.equal(notices.includes("“roads”"), false);
    assert.match(notices, /“dem”.*downsampled preview image/);
    assert.doesNotMatch(notices, /“dem”.*plugin/);
  });

  it("still reports in-memory archives and local COGs as unavailable", () => {
    const saved = project([
      pmtilesLayer("extract", "pmtiles://basemap-extract-1"),
      cogLayer("local", "/Users/me/dem.tif"),
    ]);
    assert.deepEqual(previewRenderLayers(saved), []);
    const notices = unsupportedContent(saved).join("\n");
    assert.match(notices, /“extract”.*desktop-local/);
    assert.match(notices, /“local”.*desktop-local/);
  });

  it("only lets the preview's own archives through the pmtiles scheme", () => {
    const roads = pmtilesLayer("roads", "pmtiles://https://tiles.example.com/roads.pmtiles");
    assert.equal(pmtilesArchiveUrl(roads), "https://tiles.example.com/roads.pmtiles");
    assert.equal(pmtilesArchiveKey(roads), "https://tiles.example.com/roads.pmtiles");
    const keys = new Set([pmtilesArchiveKey(roads)!]);
    assert.equal(
      isRegisteredPMTilesRequest("pmtiles://https://tiles.example.com/roads.pmtiles", keys),
      true,
    );
    assert.equal(
      isRegisteredPMTilesRequest("pmtiles://https://tiles.example.com/roads.pmtiles/4/3/2", keys),
      true,
    );
    assert.equal(
      isRegisteredPMTilesRequest("pmtiles://https://evil.example.com/a.pmtiles/4/3/2", keys),
      false,
    );
    assert.equal(
      isRegisteredPMTilesRequest("https://tiles.example.com/roads.pmtiles", keys),
      false,
    );
  });

  it("reads PMTiles ranges through the consent fetcher", async () => {
    const calls: Array<[string, number, number]> = [];
    const fetchRange: NetworkConsent["fetchRange"] = async (url, offset, length) => {
      calls.push([url, offset, length]);
      return {
        data: new Uint8Array(length).fill(7).buffer,
        cacheControl: "max-age=60",
      };
    };
    const source = new ConsentPMTilesSource(
      "key",
      "https://tiles.example.com/a.pmtiles",
      fetchRange,
    );
    const range = await source.getBytes(10, 4);
    assert.equal(source.getKey(), "key");
    assert.deepEqual([...new Uint8Array(range.data)], [7, 7, 7, 7]);
    assert.equal(range.cacheControl, "max-age=60");
    assert.deepEqual(calls, [["https://tiles.example.com/a.pmtiles", 10, 4]]);
  });
});

describe("MCP preview COG rendering helpers", () => {
  it("uses the native renderer's normalized saved zoom limits", () => {
    assert.deepEqual(styleLayerZoomRange({ ...DEFAULT_LAYER_STYLE, minZoom: 10, maxZoom: 12 }), {
      minzoom: 10,
      maxzoom: 12,
    });
    assert.deepEqual(styleLayerZoomRange({ ...DEFAULT_LAYER_STYLE, minZoom: 12, maxZoom: 10 }), {
      minzoom: 10,
      maxzoom: 12,
    });
  });
  it("recognizes the CRSs the preview can place", () => {
    assert.equal(cogEpsg({ GeographicTypeGeoKey: 4326 }), 4326);
    assert.equal(cogEpsg({ ProjectedCSTypeGeoKey: 900913 }), 3857);
    assert.equal(cogEpsg({ ProjectedCSTypeGeoKey: 32633, GeographicTypeGeoKey: 4326 }), 32633);
    assert.equal(cogEpsg({ ProjectedCSTypeGeoKey: 32767 }), null);
    assert.equal(cogEpsg({ ProjectedCSTypeGeoKey: 32767, GeographicTypeGeoKey: 4326 }), null);
    assert.equal(cogEpsg(null), null);
  });

  it("picks the smallest overview that still reaches the preview size", () => {
    const sizes = [
      { width: 8192, height: 4096 },
      { width: 4096, height: 2048 },
      { width: 2048, height: 1024 },
      { width: 1024, height: 512 },
      { width: 512, height: 256 },
    ];
    assert.equal(pickPreviewImage(sizes, 1024), 3);
    assert.equal(pickPreviewImage([{ width: 300, height: 200 }], 1024), 0);
    assert.equal(
      pickPreviewImage([
        { width: 8192, height: 8192 },
        { width: 512, height: 512 },
      ]),
      1,
    );
    assert.equal(pickPreviewImage([{ width: 8192, height: 8192 }]), -1);
    assert.deepEqual(previewSize(2048, 1024, 1024), {
      width: 1024,
      height: 512,
    });
    assert.deepEqual(previewSize(300, 200, 1024), { width: 300, height: 200 });
  });

  it("reads the saved raster state, defaulting by band count", () => {
    assert.deepEqual(cogPreviewStyle({}, 3), {
      mode: "rgb",
      bands: [1, 2, 3],
      rescale: null,
      colormap: "gray",
    });
    assert.deepEqual(cogPreviewStyle({ bands: [2], colormap: "viridis", rescale: [[0, 10]] }, 4), {
      mode: "single",
      bands: [2],
      rescale: [[0, 10]],
      colormap: "viridis",
    });
    // A band past the image's last one is ignored rather than read.
    assert.deepEqual(cogPreviewStyle({ bands: [9] }, 1).bands, [1]);
  });

  it("colors single bands through a colormap and leaves nodata transparent", () => {
    const lut = colormapLut("viridis")!;
    assert.deepEqual([...lut.slice(0, 3)], [0x44, 0x01, 0x54]);
    assert.deepEqual([...colormapLut("viridis_r")!.slice(0, 3)], [0xfd, 0xe7, 0x25]);
    assert.equal(colormapLut("no-such-map"), null);
    const { rgba, unknownColormap } = colorizeBands(
      [[0, 5, 10, -9999]],
      4,
      { mode: "single", bands: [1], rescale: [[0, 10]], colormap: "gray" },
      -9999,
    );
    assert.equal(unknownColormap, null);
    assert.deepEqual([...rgba], [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    assert.equal(
      colorizeBands([[1]], 1, { mode: "single", bands: [1], rescale: null, colormap: "nope" }, null)
        .unknownColormap,
      "nope",
    );
  });

  it("places Web Mercator and WGS 84 bounds as image corners", () => {
    const half = 20037508.342789244;
    const [topLeft, , bottomRight] = cogCorners([-half, -half, half, half], 3857);
    assert.ok(Math.abs(topLeft[0] + 180) < 1e-9 && Math.abs(topLeft[1] - 85.0511287798) < 1e-6);
    assert.ok(Math.abs(bottomRight[0] - 180) < 1e-9);
    assert.deepEqual(cogCorners([-10, -90, 10, 90], 4326)[0], [-10, 85.051129]);
  });

  it("respaces WGS 84 rows evenly in Mercator", () => {
    // Four one-pixel rows with distinct red values, spanning 0 to 80 degrees.
    const rgba = new Uint8ClampedArray([
      10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255,
    ]);
    const output = resampleToMercatorRows(rgba, 1, 4, 80, 0);
    // Mercator stretches the north, so the top source row fills more output rows.
    assert.deepEqual([output[0], output[4], output[8], output[12]], [10, 10, 20, 40]);
  });
});

describe("MCP preview COG loading", () => {
  it("resolves preview errors through the shared catalog with English fallback", async () => {
    previewI18n.addResourceBundle("es", "translation", {
      mcpPreview: { cog: { noPublicUrl: "La capa COG no tiene URL pública." } },
    });
    try {
      await previewI18n.changeLanguage("es");
      await assert.rejects(
        loadCogPreview(cogLayer("local", "file:///missing.tif"), async () => {
          throw new Error("Network must not be reached");
        }),
        /La capa COG no tiene URL pública/,
      );
      assert.match(previewI18n.t("mcpPreview.cog.byteBudget", { limit: 64 }), /64 MiB/);
    } finally {
      await previewI18n.changeLanguage("en");
      previewI18n.removeResourceBundle("es", "translation");
    }
  });
  it("rejects a large primary mask before decoding it for a small color overview", async () => {
    // GDAL: sparse 4097x4097 uint8 image, 5x5 color overview, and a
    // full-resolution internal mask with no mask overview.
    const bytes = readFileSync(new URL("./fixtures/cog-large-mask.tif", import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await assert.rejects(
      loadCogPreview(
        cogLayer("large-mask", "https://cogs.example.com/large-mask.tif"),
        rangeReader(buffer).fetchRange,
      ),
      /mask is too large/,
    );
  });
  it("applies a separate internal transparency mask", async () => {
    // A GDAL-generated 2x2 uint8 TIFF with a separate one-bit internal mask.
    const bytes = Buffer.from(
      "SUkqAAgAAAAPAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAawEAABUBAwABAAAAAQAAABYBAwABAAAAAgAAABcBBAABAAAABAAAABwBAwABAAAAAQAAAFMBAwABAAAAAQAAAA6DDAADAAAAwgAAAIKEDAAGAAAA2gAAAK+HAwAgAAAACgEAALGHAgAhAAAASgEAAHABAAAAAAAAAECPQAAAAAAAQI9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQJ9AAAAAAAAAAAABAAEAAAAHAAAEAAABAAEAAQQAAAEAAQACBLGHGQAAAAEIsYcHABkABggAAAEAjiMADAAAAQARDwQMAAABACkjV0dTIDg0IC8gUHNldWRvLU1lcmNhdG9yfFdHUyA4NHwAAAECAwANAP4ABAABAAAABAAAAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwABAAAAAQAAAAMBAwABAAAACAAAAAYBAwABAAAABAAAABEBBAABAAAAEgIAABUBAwABAAAAAQAAABYBAwABAAAAAgAAABcBBAABAAAADQAAABwBAwABAAAAAQAAAD0BAwABAAAAAQAAAFMBAwABAAAAAQAAAAAAAAB4nAECAP3/gEABQgDB",
      "base64",
    );
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const image = await loadCogPreview(
      cogLayer("mask", "https://cogs.example.com/mask.tif"),
      rangeReader(buffer).fetchRange,
    );
    assert.deepEqual(
      [image.rgba[3], image.rgba[7], image.rgba[11], image.rgba[15]],
      [255, 0, 0, 255],
    );
  });
  it("rejects an affine footprint instead of stretching it onto its bounding rectangle", async () => {
    const buffer = writeArrayBuffer([0, 1, 2, 3], {
      width: 2,
      height: 2,
      ModelTransformation: [1000, 500, 0, 0, 0, -1000, 0, 2000, 0, 0, 1, 0, 0, 0, 0, 1],
      GTModelTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 3857,
    } as never);
    await assert.rejects(
      loadCogPreview(
        cogLayer("affine", "https://cogs.example.com/affine.tif"),
        rangeReader(buffer).fetchRange,
      ),
      /rotated, skewed, or flipped/,
    );
  });
  it("unpremultiplies associated-alpha TIFF colors before applying transparency", async () => {
    const buffer = writeArrayBuffer([64, 0, 0, 128, 128, 0, 0, 255], {
      width: 2,
      height: 1,
      SamplesPerPixel: 4,
      BitsPerSample: [8, 8, 8, 8],
      PhotometricInterpretation: 2,
      ExtraSamples: [1],
      ModelPixelScale: [1, 1, 0],
      ModelTiepoint: [0, 0, 0, 10, 50, 0],
      GTModelTypeGeoKey: 2,
      GeographicTypeGeoKey: 4326,
    } as never);
    const image = await loadCogPreview(
      cogLayer("alpha", "https://cogs.example.com/alpha.tif", {
        mode: "rgb",
        bands: [1, 2, 3],
        rescale: [[0, 255]],
      }),
      rangeReader(buffer).fetchRange,
    );
    assert.deepEqual([...image.rgba], [128, 0, 0, 128, 128, 0, 0, 255]);
  });
  function tinyGeoTiff(epsg: number): ArrayBuffer {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const metadata: Record<string, unknown> = {
      width: 4,
      height: 3,
      ModelPixelScale: [1, 1, 0],
      ModelTiepoint: [0, 0, 0, 10, 50, 0],
    };
    if (epsg === 4326)
      Object.assign(metadata, {
        GTModelTypeGeoKey: 2,
        GeographicTypeGeoKey: 4326,
      });
    else
      Object.assign(metadata, {
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: epsg,
      });
    return writeArrayBuffer(values, metadata as never);
  }

  function rangeReader(buffer: ArrayBuffer) {
    const reads: Array<[number, number]> = [];
    const fetchRange: NetworkConsent["fetchRange"] = async (_url, offset, length) => {
      reads.push([offset, length]);
      return {
        data: buffer.slice(offset, offset + length),
        totalSize: buffer.byteLength,
      };
    };
    return { reads, fetchRange };
  }

  it("decodes a WGS 84 GeoTIFF through ranged reads into a placed image", async () => {
    const { reads, fetchRange } = rangeReader(tinyGeoTiff(4326));
    const image = await loadCogPreview(
      cogLayer("tiny", "https://cogs.example.com/tiny.tif", {
        colormap: "gray",
        rescale: [[0, 11]],
      }),
      fetchRange,
    );
    assert.ok(reads.length > 0);
    assert.equal(reads[0][1], 256 * 1024);
    assert.equal(image.width, 4);
    assert.equal(image.height, 3);
    assert.deepEqual(image.corners[0], [10, 50]);
    assert.deepEqual(image.corners[2], [14, 47]);
    // Bottom-right pixel (value 11) is white and opaque.
    assert.deepEqual([...image.rgba.slice(-4)], [255, 255, 255, 255]);
    assert.equal(image.unknownColormap, null);
  });

  it("preserves transparent and partially transparent declared alpha samples", async () => {
    const buffer = writeArrayBuffer([50, 60, 70, 0, 100, 110, 120, 128], {
      width: 2,
      height: 1,
      SamplesPerPixel: 4,
      BitsPerSample: [8, 8, 8, 8],
      PhotometricInterpretation: 2,
      ExtraSamples: [2],
      ModelPixelScale: [1, 1, 0],
      ModelTiepoint: [0, 0, 0, 10, 50, 0],
      GTModelTypeGeoKey: 2,
      GeographicTypeGeoKey: 4326,
    } as never);
    const { fetchRange } = rangeReader(buffer);
    const image = await loadCogPreview(
      cogLayer("alpha", "https://cogs.example.com/alpha.tif"),
      fetchRange,
    );
    assert.deepEqual([image.rgba[3], image.rgba[7]], [0, 128]);
  });

  it("refuses CRSs it cannot place and reads past the byte budget", async () => {
    await assert.rejects(
      loadCogPreview(
        cogLayer("utm", "https://cogs.example.com/utm.tif"),
        rangeReader(tinyGeoTiff(32633)).fetchRange,
      ),
      /EPSG:32633/,
    );
    await assert.rejects(
      loadCogPreview(
        cogLayer("tiny", "https://cogs.example.com/tiny.tif"),
        rangeReader(tinyGeoTiff(4326)).fetchRange,
        undefined,
        16,
      ),
      /stopped after reading/,
    );
  });
});

describe("MCP preview ranged fetches", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function consentWith(respond: (args: Record<string, unknown>) => Record<string, unknown>): {
    consent: NetworkConsent;
    fetches: Array<Record<string, unknown>>;
    panel: HTMLElement;
  } {
    const panel = document.createElement("section");
    document.body.append(panel);
    const fetches: Array<Record<string, unknown>> = [];
    const transport: PreviewToolTransport = async (params) => {
      const args = params.arguments as Record<string, unknown>;
      if (params.name === "approve_map_origin")
        return {
          structuredContent: { grant: "grant", expiresIn: 300 },
        } as never;
      if (params.name === "fetch_map_resource") {
        fetches.push(args);
        return { structuredContent: respond(args) } as never;
      }
      return { structuredContent: { closed: true } } as never;
    };
    const consent = createNetworkConsent(panel, "preview", transport, () => {}, [
      "https://tiles.example.com",
    ]);
    cleanups.push(async () => {
      await consent.dispose();
      panel.remove();
    });
    return { consent, fetches, panel };
  }

  async function allow(panel: HTMLElement): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    panel.querySelector<HTMLButtonElement>('button[data-consent-action="allow"]')!.click();
  }

  function encode(length: number, fill: number): string {
    return Buffer.from(new Uint8Array(length).fill(fill)).toString("base64");
  }

  it("splits a read larger than the server cap and joins the parts", async () => {
    const { consent, fetches, panel } = consentWith((args) => ({
      data: encode(Number(args.length), Number(args.offset) === 5 ? 1 : 2),
      mimeType: "application/octet-stream",
      rangeStart: args.offset,
      totalSize: 1 << 30,
    }));
    const pending = consent.fetchRange(
      "https://tiles.example.com/a.pmtiles",
      5,
      MAX_RANGE_BYTES + 3,
    );
    await allow(panel);
    const range = await pending;
    assert.deepEqual(
      fetches.map(({ offset, length }) => [offset, length]),
      [
        [5, MAX_RANGE_BYTES],
        [5 + MAX_RANGE_BYTES, 3],
      ],
    );
    const bytes = new Uint8Array(range.data);
    assert.equal(bytes.length, MAX_RANGE_BYTES + 3);
    assert.equal(bytes[0], 1);
    assert.equal(bytes[bytes.length - 1], 2);
    assert.equal(range.totalSize, 1 << 30);
  });

  it("rejects a response for a different range", async () => {
    const { consent, panel } = consentWith((args) => ({
      data: encode(Number(args.length), 0),
      mimeType: "application/octet-stream",
      rangeStart: Number(args.offset) + 1,
    }));
    const pending = consent.fetchRange("https://tiles.example.com/a.pmtiles", 0, 8);
    await allow(panel);
    await assert.rejects(pending, /different byte range/);
  });

  it("continues short partial reads until the requested range is complete", async () => {
    const { consent, fetches, panel } = consentWith((args) => ({
      data: encode(Math.min(3, Number(args.length)), Number(args.offset)),
      mimeType: "application/octet-stream",
      rangeStart: args.offset,
      totalSize: 100,
    }));
    const pending = consent.fetchRange("https://tiles.example.com/a.pmtiles", 10, 8);
    await allow(panel);
    const result = await pending;
    assert.deepEqual(
      fetches.map(({ offset, length }) => [offset, length]),
      [
        [10, 8],
        [13, 5],
        [16, 2],
      ],
    );
    assert.deepEqual([...new Uint8Array(result.data)], [10, 10, 10, 13, 13, 13, 16, 16]);
  });
});
