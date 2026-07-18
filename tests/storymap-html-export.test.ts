import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_STORY_MAP,
  type GeoLibreLayer,
  type StoryMap,
} from "@geolibre/core";
import { buildStoryMapHtml } from "../apps/geolibre-desktop/src/lib/storymap-export";

function story(overrides: Partial<StoryMap> = {}): StoryMap {
  return {
    ...DEFAULT_STORY_MAP,
    title: "Change",
    chapters: [
      {
        id: "chapter-1",
        title: "Before",
        description: "",
        alignment: "center",
        hidden: false,
        location: { center: [77.3, 13.0], zoom: 12, pitch: 0, bearing: 0 },
        mapAnimation: "flyTo",
        rotateAnimation: false,
        onChapterEnter: [{ layerId: "scene-a", opacity: 1, duration: 1000 }],
        onChapterExit: [],
      },
      {
        id: "chapter-2",
        title: "After",
        description: "",
        alignment: "center",
        hidden: false,
        location: { center: [77.3, 13.0], zoom: 12, pitch: 0, bearing: 0 },
        mapAnimation: "flyTo",
        rotateAnimation: false,
        onChapterEnter: [{ layerId: "scene-a", opacity: 0, duration: 1000 }],
        onChapterExit: [],
      },
    ],
    ...overrides,
  };
}

function rasterLayer(
  id: string,
  source: Record<string, unknown>,
  patch: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "raster",
    source,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

const TILEJSON_URL =
  "https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json?collection=sentinel-2-l2a&item=S2A&assets=visual";

describe("buildStoryMapHtml raster sources", () => {
  it("inlines a raster layer whose source is a TileJSON url (#1272)", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        rasterLayer("scene-a", {
          type: "raster",
          url: TILEJSON_URL,
          tileSize: 256,
          bounds: [76.8, 12.5, 77.9, 13.6],
          attribution: "Microsoft Planetary Computer",
        }),
      ],
    });
    assert.ok(html.includes("scene-a-source"), "adds the raster source");
    assert.ok(html.includes(JSON.stringify(TILEJSON_URL)), "embeds the TileJSON url");
    // The chapter opacity effects survive because the layer was inlined.
    assert.ok(
      html.includes('"layer": "scene-a"'),
      "keeps the chapter opacity effects targeting the layer",
    );
    assert.ok(
      html.includes('"bounds"'),
      "carries the source bounds so tiles stay inside the scene",
    );
  });

  it("still inlines tile-template raster layers, preferring tiles over url", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        rasterLayer("scene-a", {
          type: "raster",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
          url: TILEJSON_URL,
        }),
      ],
    });
    assert.ok(html.includes("scene-a-source"));
    assert.ok(html.includes("https://tiles.example.com/{z}/{x}/{y}.png"));
    assert.ok(!html.includes(JSON.stringify(TILEJSON_URL)), "does not also embed the TileJSON url");
  });

  it("drops raster layers whose url is not http(s)", () => {
    for (const url of [
      "blob:https://app.example/1234",
      "pmtiles://https://example.com/a.pmtiles",
      "geolibre://offline-basemap",
    ]) {
      const html = buildStoryMapHtml({
        storymap: story(),
        basemapStyleUrl: "https://tiles.example.com/style.json",
        layers: [rasterLayer("scene-a", { type: "raster", url })],
      });
      assert.ok(!html.includes("scene-a-source"), `does not inline a source for ${url}`);
      assert.ok(!html.includes('"layer": "scene-a"'), `filters the chapter effects for ${url}`);
    }
  });

  it("drops tile templates that are not http(s)", () => {
    for (const tile of [
      "blob:https://app.example/1234",
      "pmtiles://https://example.com/a.pmtiles/{z}/{x}/{y}",
      "geolibre://local/{z}/{x}/{y}.png",
    ]) {
      const html = buildStoryMapHtml({
        storymap: story(),
        basemapStyleUrl: "https://tiles.example.com/style.json",
        layers: [rasterLayer("scene-a", { type: "raster", tiles: [tile] })],
      });
      assert.ok(!html.includes("scene-a-source"), `does not inline a source for ${tile}`);
      assert.ok(!html.includes('"layer": "scene-a"'), `filters the chapter effects for ${tile}`);
    }
  });

  it("does not embed a wms/wmts service endpoint as a TileJSON url", () => {
    // WMS/WMTS records carry the raw service endpoint in `url` (not a
    // TileJSON); with no usable tiles the layer must be omitted, not exported
    // as a source MapLibre cannot parse.
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        rasterLayer(
          "scene-a",
          { type: "raster", url: "https://example.com/wms", tiles: [] },
          { type: "wms" },
        ),
      ],
    });
    assert.ok(!html.includes("scene-a-source"));
    assert.ok(!html.includes("https://example.com/wms"));
  });

  it("drops raster layers with neither tiles nor url", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        rasterLayer("scene-a", {
          type: "raster",
          collectionId: "sentinel-2-l2a",
        }),
      ],
    });
    assert.ok(!html.includes("scene-a-source"));
  });
});
