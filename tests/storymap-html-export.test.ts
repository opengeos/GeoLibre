import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_STORY_MAP,
  type GeoLibreLayer,
  type StoryMap,
} from "@geolibre/core";
import {
  buildStoryMapHtml,
  storyExportCandidates,
} from "../apps/geolibre-desktop/src/lib/storymap-export";
import { resolveTextFontFromStyleLayers } from "../packages/map/src/text-font";

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

/** Parse the `var config = {...};` block the exported page embeds. */
function exportedConfig(html: string): Record<string, unknown> {
  const match = /var config = (\{[\s\S]*?\});\n\s*<\/script>/.exec(html);
  assert.ok(match, "config block present");
  return JSON.parse(match[1].replace(/<\\\//g, "</").replace(/<\\!--/g, "<!--"));
}

const COG_URL = "https://storage.googleapis.com/wfamaps/GermanMap_12Mar16_cog2.tif";

function markerLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "markers",
    name: "Markers",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      markerEnabled: true,
      markerShape: "pin",
      markerColor: "#ff0000",
      markerSize: 32,
    },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [2.886, 50.85] },
          properties: {
            name: "Ypres",
            desc: "Ypres Salient",
            photo: "https://example.com/ypres.png",
            url: "https://geolibre.app",
            evil: "javascript:alert(1)",
          },
        },
      ],
    },
    ...patch,
  };
}

const MARKER_IMAGE = { dataUrl: "data:image/png;base64,AAAA", pixelRatio: 2, iconSize: 1 };

describe("buildStoryMapHtml COG layers (#2597)", () => {
  it("inlines a remote COG through the cog:// protocol and loads the protocol script", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [rasterLayer("scene-a", { type: "raster", url: COG_URL }, { type: "cog" })],
    });
    assert.match(html, /map\.addSource\("scene-a-source", \{"type":"raster","url":"cog:\/\/https:/);
    assert.match(html, /maplibre-cog-protocol@0\.10\.0\/dist\/index\.js' integrity='sha384-/);
    assert.match(html, /maplibregl\.addProtocol\('cog'/);
  });

  it("skips a COG that is not reachable over http(s) and omits the protocol script", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        rasterLayer("scene-a", { type: "raster", url: "blob:http://localhost/1" }, { type: "cog" }),
      ],
    });
    assert.doesNotMatch(html, /scene-a-source/);
    assert.doesNotMatch(html, /maplibre-cog-protocol/);
  });
});

describe("buildStoryMapHtml markers and popups (#2597)", () => {
  it("draws a marker-enabled point layer with its baked sprite", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [markerLayer()],
      markerImages: { markers: MARKER_IMAGE },
    });
    assert.match(html, /"type":"symbol","layout":\{"icon-image":"geolibre-story-marker-markers"/);
    assert.match(html, /"icon-opacity":1/);
    const config = exportedConfig(html);
    assert.deepEqual(config.markerImages, {
      "geolibre-story-marker-markers": { url: MARKER_IMAGE.dataUrl, pixelRatio: 2 },
    });
  });

  it("falls back to a circle when no sprite was baked", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [markerLayer()],
    });
    assert.match(html, /map\.addLayer\(\{"type":"circle"/);
    assert.deepEqual(exportedConfig(html).markerImages, {});
  });

  it("resolves the authored popup and tooltip, keeping only safe URLs", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        markerLayer({
          popup: {
            click: true,
            hover: true,
            titleField: "name",
            fields: [
              { field: "desc", label: "Site", hover: true },
              { field: "photo", label: "Photo", kind: "image" },
              { field: "url", kind: "link", format: { linkLabel: "Click Here" } },
              { field: "evil", kind: "link" },
            ],
          },
        }),
      ],
      markerImages: { markers: MARKER_IMAGE },
    });
    assert.match(html, /"generateId":true/);
    const popups = exportedConfig(html).popups as Record<string, unknown[]>;
    assert.deepEqual(popups.markers, [
      {
        t: "Ypres",
        r: [
          { l: "Site", k: "text", v: "Ypres Salient" },
          {
            l: "Photo",
            k: "image",
            v: "",
            u: "https://example.com/ypres.png",
          },
          { l: "url", k: "link", v: "Click Here", u: "https://geolibre.app" },
          { l: "evil", k: "text", v: "javascript:alert(1)" },
        ],
        ht: "Ypres",
        hr: [{ l: "Site", k: "text", v: "Ypres Salient" }],
      },
    ]);
  });

  it("adds no popups for a layer without a popup config", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [markerLayer()],
    });
    assert.deepEqual(exportedConfig(html).popups, {});
    assert.doesNotMatch(html, /"generateId":true/);
  });
});

describe("buildStoryMapHtml inline popup images (#2597)", () => {
  it("references an inline data image by field instead of embedding it twice", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(4096)}`;
    const layer = markerLayer({ popup: { fields: [{ field: "thumb", kind: "image" }] } });
    layer.geojson!.features[0].properties!.thumb = dataUrl;
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [layer],
    });
    const popups = exportedConfig(html).popups as Record<string, Array<{ r: unknown[] }>>;
    assert.deepEqual(popups.markers[0].r, [{ l: "thumb", k: "image", v: "", p: "thumb" }]);
    assert.equal(html.split(dataUrl).length - 1, 1, "data URL appears once, in the GeoJSON");
  });
});

describe("storyExportCandidates (#2597)", () => {
  it("keeps visible and chapter-referenced layers only", () => {
    const layers = [
      rasterLayer("scene-a", {}, { visible: false }),
      rasterLayer("shown", {}),
      rasterLayer("hidden", {}, { visible: false }),
    ];
    assert.deepEqual(
      storyExportCandidates(story(), layers).map((layer) => layer.id),
      ["scene-a", "shown"],
    );
  });
});

describe("buildStoryMapHtml popup expressions (#2597)", () => {
  it("evaluates a title expression at the story's opening zoom", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [markerLayer({ popup: { titleExpression: '["to-string", ["zoom"]]' } })],
    });
    const popups = exportedConfig(html).popups as Record<string, Array<{ t: string }>>;
    assert.equal(popups.markers[0].t, "12");
  });
});

/** A categorized polygon layer, labelled by a field when `labels` is set. */
function categorizedPolygons(patch: Partial<GeoLibreLayer["style"]> = {}): GeoLibreLayer {
  return {
    id: "zones",
    name: "Zones",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 0.5,
    style: {
      ...DEFAULT_LAYER_STYLE,
      vectorStyleMode: "categorized",
      vectorStyleProperty: "kind",
      vectorStyleStops: [
        { value: "park", color: "#00ff00" },
        { value: "lake", color: "#0000ff" },
      ],
      ...patch,
    },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          properties: { kind: "park", name: "Central" },
        },
      ],
    },
  };
}

/** The spec the page passes to `map.addLayer`/`addLabelLayer` for `id`. */
function exportedLayerSpec(html: string, call: string, id: string): Record<string, unknown> {
  for (const line of html.split("\n")) {
    const match = new RegExp(`^\\s*${call}\\((\\{.*\\})\\);$`).exec(line);
    if (!match) continue;
    const spec = JSON.parse(match[1]) as Record<string, unknown>;
    if (spec.id === id) return spec;
  }
  throw new Error(`no ${call} for ${id}`);
}

describe("buildStoryMapHtml symbology and labels (#3033)", () => {
  it("exports a categorized renderer as its data-driven color expression", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [categorizedPolygons()],
    });
    const spec = exportedLayerSpec(html, "map.addLayer", "zones");
    const paint = spec.paint as Record<string, unknown>;
    const color = JSON.stringify(paint["fill-color"]);
    assert.match(color, /"match"/);
    assert.match(color, /"park","#00ff00"/);
    assert.match(color, /"lake","#0000ff"/);
    assert.equal(paint["fill-opacity"], DEFAULT_LAYER_STYLE.fillOpacity * 0.5);
  });

  it("adds a label layer that fades with its layer", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        categorizedPolygons({
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name", size: 16 },
        }),
      ],
    });
    const label = exportedLayerSpec(html, "addLabelLayer", "zones::label");
    assert.equal(label.type, "symbol");
    assert.equal(label.source, "zones-source");
    const layout = label.layout as Record<string, unknown>;
    assert.match(JSON.stringify(layout["text-field"]), /"name"/);
    assert.equal(layout["text-size"], 16);
    // The page resolves the font against the basemap at load time.
    assert.equal(layout["text-font"], undefined);
    assert.equal((label.paint as Record<string, unknown>)["text-opacity"], 0.5);
    const config = exportedConfig(html);
    assert.equal(config.labelLayerSuffix, "::label");
    assert.match(String(config.labelGlyphs), /^https:\/\/.*\{fontstack\}\/\{range\}\.pbf$/);
    assert.match(html, /fadeLayer\(layer\.layer \+ config\.labelLayerSuffix/);
  });

  it("adds no label layer when labels are off", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [categorizedPolygons()],
    });
    assert.doesNotMatch(html, /addLabelLayer\(\{/);
  });

  it("seeds the label from chapter 0's opacity", () => {
    const html = buildStoryMapHtml({
      storymap: story({
        chapters: story().chapters.map((chapter, index) =>
          index === 0
            ? { ...chapter, onChapterEnter: [{ layerId: "zones", opacity: 0 }] }
            : chapter,
        ),
      }),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [
        categorizedPolygons({
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name" },
        }),
      ],
    });
    const label = exportedLayerSpec(html, "addLabelLayer", "zones::label");
    assert.equal((label.paint as Record<string, unknown>)["text-opacity"], 0);
  });
});

describe("buildStoryMapHtml label font resolution (#3033)", () => {
  it("resolves fonts exactly as the live map's resolver does", () => {
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [],
    });
    const source = /function resolveLabelFont\(layers\) \{[\s\S]*?\n {8}\}/.exec(html);
    assert.ok(source, "page defines resolveLabelFont");
    const pageResolve = new Function(`${source[0]}; return resolveLabelFont;`)() as (
      layers: unknown,
    ) => string[] | null;
    const fixtures: Array<Array<{ type: string; layout?: Record<string, unknown> }>> = [
      [],
      [{ type: "fill" }],
      [{ type: "symbol", layout: { "icon-image": "x", "text-font": ["Icon Font"] } }],
      [{ type: "symbol", layout: { "text-field": "{name}", "text-font": ["Noto Sans Bold"] } }],
      [
        {
          type: "symbol",
          layout: { "text-field": "{name}", "text-font": ["literal", ["Open Sans", "Arial"]] },
        },
      ],
      [
        { type: "symbol", layout: { "text-field": "{name}", "text-font": ["get", "font"] } },
        { type: "symbol", layout: { "text-field": "{ref}", "text-font": ["Roboto Regular"] } },
      ],
      [{ type: "symbol", layout: { "text-field": "{name}" } }],
    ];
    const fallback = ["Fallback"];
    for (const layers of fixtures) {
      assert.deepEqual(
        pageResolve(layers) ?? fallback,
        resolveTextFontFromStyleLayers(layers, fallback),
        JSON.stringify(layers),
      );
    }
  });

  it("exports a categorized point layer's circle color expression", () => {
    const layer = markerLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "categorized",
        vectorStyleProperty: "name",
        vectorStyleStops: [{ value: "Ypres", color: "#ff8800" }],
      },
    });
    const html = buildStoryMapHtml({
      storymap: story(),
      basemapStyleUrl: "https://tiles.example.com/style.json",
      layers: [layer],
    });
    const spec = exportedLayerSpec(html, "map.addLayer", "markers");
    assert.equal(spec.type, "circle");
    assert.match(
      JSON.stringify((spec.paint as Record<string, unknown>)["circle-color"]),
      /"Ypres","#ff8800"/,
    );
  });
});
