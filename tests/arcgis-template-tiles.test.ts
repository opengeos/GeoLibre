import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { compileArcgisLayer, isArcgisSupportedLayer } from "../packages/map/src/arcgis-layers";
import {
  createArcgisTemplateTileLayer,
  sourceTileFor,
  tileTemplateUrl,
} from "../packages/map/src/arcgis-template-tiles";
import type { ArcgisSdk } from "../packages/map/src/arcgis-sdk";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Raster templates the SDK's WebTileLayer cannot express (issue #2477): the
// ArcGIS Layer panel's dynamic `/export` records, bounding-box templates typed
// `wms`, TMS rows, 512 px tiles and a source zoom range.

function rasterLayer(type: string, source: Record<string, unknown>): GeoLibreLayer {
  return {
    ...geojsonLayer({ geojson: undefined }),
    type: type as GeoLibreLayer["type"],
    source: { type: "raster", ...source },
    style: { ...DEFAULT_LAYER_STYLE },
  };
}

describe("tileTemplateUrl", () => {
  it("fills a bounding box with the tile's Web Mercator extent, as MapLibre does", () => {
    const url = tileTemplateUrl(
      { templates: ["https://h/export?bbox={bbox-epsg-3857}&f=image"], scheme: "xyz" },
      1,
      0,
      0,
    );
    assert.equal(url, "https://h/export?bbox=-20037508.342789244,0,0,20037508.342789244&f=image");
  });
  it("flips the row for a TMS scheme and for {-y}", () => {
    const tms = { templates: ["https://t/{z}/{x}/{y}.png"], scheme: "tms" as const };
    assert.equal(tileTemplateUrl(tms, 3, 1, 2), "https://t/3/1/5.png");
    const minusY = { templates: ["https://t/{z}/{x}/{-y}.png"], scheme: "xyz" as const };
    assert.equal(tileTemplateUrl(minusY, 3, 1, 2), "https://t/3/1/5.png");
  });
  it("fills quadkeys and rotates through several templates", () => {
    const source = {
      templates: ["https://a/{quadkey}", "https://b/{quadkey}"],
      scheme: "xyz" as const,
    };
    assert.equal(tileTemplateUrl(source, 3, 3, 5), "https://a/213");
    assert.equal(tileTemplateUrl(source, 3, 3, 4), "https://b/211");
  });
});

describe("sourceTileFor", () => {
  const source = { tileSize: 256, minzoom: 0, maxzoom: 22 };
  it("maps a 256 px tile one to one", () => {
    assert.deepEqual(sourceTileFor(source, 5, 10, 11), { z: 5, x: 11, y: 10, factor: 1 });
  });
  it("draws a 512 px tile one level earlier, cropped to the quadrant", () => {
    assert.deepEqual(sourceTileFor({ ...source, tileSize: 512 }, 5, 10, 11), {
      z: 4,
      x: 5,
      y: 5,
      factor: 2,
    });
    // Never below zoom 0: the world tile fills level 0.
    assert.deepEqual(sourceTileFor({ ...source, tileSize: 512 }, 0, 0, 0), {
      z: 0,
      x: 0,
      y: 0,
      factor: 1,
    });
  });
  it("overzooms past maxzoom and draws nothing below minzoom", () => {
    assert.deepEqual(sourceTileFor({ ...source, maxzoom: 3 }, 5, 9, 17), {
      z: 3,
      x: 4,
      y: 2,
      factor: 4,
    });
    assert.equal(sourceTileFor({ ...source, minzoom: 4 }, 3, 0, 0), null);
  });
});

describe("compileArcgisLayer template tiles", () => {
  it("draws a dynamic MapServer export record instead of rejecting its bbox", () => {
    const layer = rasterLayer("raster", {
      tiles: [
        "https://h/arcgis/rest/services/X/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:0,2&f=image",
      ],
      tileSize: 256,
      bounds: [-10, -5, 10, 5],
    });
    const plan = compileArcgisLayer(layer);
    assert.equal(plan.kind, "template-tile");
    if (plan.kind !== "template-tile") return;
    assert.match(plan.templates[0], /layers=show:0,2/);
    assert.deepEqual(plan.bounds, [-10, -5, 10, 5]);
    assert.equal(isArcgisSupportedLayer(layer), true);
  });
  it("draws a bounding-box template typed wms that names no WMS layers", () => {
    const layer = rasterLayer("wms", {
      tiles: [
        "https://elevation.example/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&size=256,256&format=png&f=image",
      ],
    });
    const plan = compileArcgisLayer(layer);
    assert.equal(plan.kind, "template-tile");
  });
  it("draws a MapServer sublayer export typed wms, whose layers param is not WMS", () => {
    const plan = compileArcgisLayer(
      rasterLayer("wms", {
        tiles: [
          "https://h/arcgis/rest/services/X/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&size=256,256&format=png32&transparent=true&layers=show:3&f=image",
        ],
      }),
    );
    assert.equal(plan.kind, "template-tile");
    // A GetMap template, or a WMS one with no request named, is still WMS.
    const wms = compileArcgisLayer(
      rasterLayer("wms", {
        tiles: ["https://h/wms?SERVICE=WMS&LAYERS=roads&BBOX={bbox-epsg-3857}"],
      }),
    );
    assert.equal(wms.kind, "wms");
  });
  it("keeps TMS, tile size and zoom range", () => {
    const plan = compileArcgisLayer(
      rasterLayer("xyz", {
        tiles: ["https://t/{z}/{x}/{y}.png", "https://u/{z}/{x}/{y}.png"],
        scheme: "tms",
        tileSize: 512,
        minzoom: 2,
        maxzoom: 14,
      }),
    );
    assert.equal(plan.kind, "template-tile");
    if (plan.kind !== "template-tile") return;
    assert.deepEqual(
      {
        templates: plan.templates,
        scheme: plan.scheme,
        tileSize: plan.tileSize,
        minzoom: plan.minzoom,
        maxzoom: plan.maxzoom,
      },
      {
        templates: ["https://t/{z}/{x}/{y}.png", "https://u/{z}/{x}/{y}.png"],
        scheme: "tms",
        tileSize: 512,
        minzoom: 2,
        maxzoom: 14,
      },
    );
  });
  it("keeps the plain WebTileLayer path for a simple XYZ template", () => {
    const plan = compileArcgisLayer(rasterLayer("xyz", { tiles: ["https://t/{z}/{x}/{y}.png"] }));
    assert.equal(plan.kind, "web-tile");
  });
  it("still rejects placeholders MapLibre has no form for", () => {
    assert.throws(() =>
      compileArcgisLayer(
        rasterLayer("wms", { tiles: ["https://h/wms?bbox={bbox-epsg-4326}&f=image"] }),
      ),
    );
  });
});

describe("createArcgisTemplateTileLayer", () => {
  /** A fake SDK whose BaseTileLayer subclass exposes the definition's methods. */
  function makeLayer(
    source: Parameters<typeof createArcgisTemplateTileLayer>[1],
    respond: (url: string) => { status: number },
  ) {
    const draws: unknown[][] = [];
    const requested: string[] = [];
    const sdk = {
      layers: {
        BaseTileLayer: {
          createSubclass: (definition: Record<string, unknown>) =>
            class {
              constructor(public props: Record<string, unknown>) {
                Object.assign(this, definition);
              }
            },
        },
      },
    } as unknown as ArcgisSdk;
    const fetchImpl = async (url: string) => {
      requested.push(url);
      const { status } = respond(url);
      return {
        status,
        ok: status >= 200 && status < 300,
        blob: async () => new Blob(["png"]),
      } as Response;
    };
    const layer = createArcgisTemplateTileLayer(
      sdk,
      source,
      { title: "T" },
      fetchImpl,
    ) as unknown as {
      fetchTile(level: number, row: number, col: number): Promise<{ width: number }>;
    };
    const previous = {
      document: globalThis.document,
      createImageBitmap: globalThis.createImageBitmap,
    };
    Object.assign(globalThis, {
      document: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }),
        }),
      },
      createImageBitmap: async () => ({ width: 512, height: 512, close: () => {} }),
    });
    const restore = () => Object.assign(globalThis, previous);
    return { layer, draws, requested, restore };
  }
  const source = {
    templates: ["https://t/{z}/{x}/{y}.png"],
    scheme: "xyz" as const,
    tileSize: 512,
    minzoom: 2,
    maxzoom: 22,
  };

  it("crops the quadrant of a 512 px source tile into the 256 px tile", async () => {
    const { layer, draws, requested, restore } = makeLayer(source, () => ({ status: 200 }));
    try {
      const canvas = await layer.fetchTile(5, 10, 11);
      assert.equal(canvas.width, 256);
      assert.deepEqual(requested, ["https://t/4/5/5.png"]);
      // Column 11 is the right half and row 10 the top half of source tile 5/5.
      assert.deepEqual(draws[0].slice(1), [256, 0, 256, 256, 0, 0, 256, 256]);
    } finally {
      restore();
    }
  });
  it("draws a gap for a missing tile, nothing below minzoom, and fails on a server error", async () => {
    const { layer, draws, requested, restore } = makeLayer(source, (url) => ({
      status: url.includes("/9/") ? 500 : 404,
    }));
    try {
      await layer.fetchTile(5, 10, 11);
      await layer.fetchTile(2, 0, 0);
      assert.equal(draws.length, 0);
      assert.deepEqual(requested, ["https://t/4/5/5.png"]);
      await assert.rejects(layer.fetchTile(10, 0, 0), /500/);
    } finally {
      restore();
    }
  });
});
