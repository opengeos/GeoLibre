import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlanetaryComputerLayer, PLANETARY_COMPUTER_SOURCE_KIND } from "@geolibre/core";
import type { ActiveLayer, STACItem } from "maplibre-gl-planetary-computer";
import {
  createPlanetaryComputerStoreLayer,
  planetaryComputerItemDate,
  planetaryComputerSavedStyle,
  planetaryComputerSearchParams,
} from "../packages/plugins/src/plugins/maplibre-planetary-computer";
import {
  clampClipBounds,
  parsePlanetaryComputerStack,
  PLANETARY_COMPUTER_STACK_KEY,
  planetaryComputerColorbar,
  planetaryComputerStackItemAt,
  planetaryComputerStackItems,
  planetaryComputerStackReader,
  planetaryComputerStackSource,
  type PlanetaryComputerStack,
} from "../packages/plugins/src/plugins/planetary-computer-actions";
import { isBridgedRasterIdentifyLayer } from "../packages/map/src/identify-sources";
import {
  planetaryComputerIdentifyProperties,
  wrapLongitude,
} from "../apps/geolibre-desktop/src/lib/global-raster-identify";

function stacItem(id: string, properties: Record<string, unknown>): STACItem {
  return {
    id,
    type: "Feature",
    stac_version: "1.0.0",
    geometry: { type: "Point", coordinates: [0, 0] },
    bbox: [-123, 46.8, -121.5, 47.8],
    properties: { datetime: null, ...properties },
    links: [],
    assets: {},
    collection: "sentinel-2-l2a",
  } as STACItem;
}

describe("createPlanetaryComputerStoreLayer", () => {
  it("mirrors an item layer with everything a restore needs", () => {
    const active: ActiveLayer = {
      id: "layer-1",
      type: "item",
      sourceId: "layer-1-source",
      item: stacItem("S2_ITEM", { datetime: "2024-08-29T18:59:19Z" }),
      visible: true,
      opacity: 0.5,
      assets: [],
      renderParams: { expression: "(B08-B04)/(B08+B04)", asset_as_band: true },
      presetName: "ndvi",
    };
    const layer = createPlanetaryComputerStoreLayer(active);

    assert.equal(layer.id, "layer-1");
    assert.equal(layer.name, "S2_ITEM");
    assert.equal(layer.type, "raster");
    assert.equal(layer.opacity, 0.5);
    assert.equal(layer.metadata.sourceKind, PLANETARY_COMPUTER_SOURCE_KIND);
    assert.equal(layer.metadata.planetaryComputerLayerType, "item");
    assert.equal(layer.metadata.stacCollectionId, "sentinel-2-l2a");
    assert.equal(layer.metadata.stacItemId, "S2_ITEM");
    assert.equal(layer.metadata.stacDatetime, "2024-08-29T18:59:19Z");
    assert.equal(layer.metadata.presetName, "ndvi");
    assert.deepEqual(layer.metadata.renderParams, active.renderParams);
    assert.deepEqual(layer.metadata.bounds, [-123, 46.8, -121.5, 47.8]);
    assert.deepEqual(layer.metadata.nativeLayerIds, ["layer-1"]);
    assert.ok(isPlanetaryComputerLayer(layer));
    // Identify reads these layers through the application's raster bridge.
    assert.equal(layer.metadata.identifiable, true);
    assert.ok(isBridgedRasterIdentifyLayer(layer));
  });

  it("mirrors a mosaic with its search and names it by collection and date range", () => {
    const searchParams = {
      collections: ["sentinel-2-l2a"],
      datetime: "2024-06-01T00:00:00Z/2024-08-31T23:59:59Z",
      query: { "eo:cloud_cover": { lte: 10 } },
    };
    const layer = createPlanetaryComputerStoreLayer({
      id: "mosaic-1",
      type: "mosaic",
      sourceId: "mosaic-1-source",
      collection: {
        id: "sentinel-2-l2a",
        title: "Sentinel-2 Level-2A",
      } as ActiveLayer["collection"],
      mosaicId: "pc1.expiring.id",
      searchParams,
      bounds: [-123.5, 46.8, -121, 48.5],
      visible: true,
      opacity: 1,
      assets: ["visual"],
      renderParams: { assets: ["visual"] },
    });

    assert.equal(layer.name, "Sentinel-2 Level-2A (2024-06-01 to 2024-08-31)");
    assert.equal(layer.metadata.planetaryComputerLayerType, "mosaic");
    assert.deepEqual(layer.metadata.stacSearchParams, searchParams);
    assert.deepEqual(layer.metadata.bounds, [-123.5, 46.8, -121, 48.5]);
    assert.equal(layer.metadata.stacItemId, undefined);
    // The search id expires, so it is never saved; restore registers the search again.
    assert.ok(!JSON.stringify(layer).includes("pc1.expiring.id"));
  });

  it("reduces a 3D item bbox to 2D bounds", () => {
    const item = stacItem("DEM", {});
    item.bbox = [-123, 46, 0, -122, 47, 4000];
    const layer = createPlanetaryComputerStoreLayer({
      id: "dem",
      type: "item",
      sourceId: "dem-source",
      item,
      visible: true,
      opacity: 1,
      assets: ["data"],
      renderParams: {},
    });
    assert.deepEqual(layer.metadata.bounds, [-123, 46, -122, 47]);
  });
});

describe("planetaryComputerSavedStyle", () => {
  const saved = async (metadata: Record<string, unknown>) => {
    const module = await import("maplibre-gl-planetary-computer");
    const layer = createPlanetaryComputerStoreLayer({
      id: "l",
      type: "item",
      sourceId: "l-source",
      item: stacItem("S2_ITEM", {}),
      visible: true,
      opacity: 1,
      assets: [],
      renderParams: {},
    });
    layer.metadata = { ...layer.metadata, ...metadata };
    return planetaryComputerSavedStyle(module, layer, "sentinel-2-l2a");
  };

  it("uses the collection default when nothing was saved", async () => {
    assert.deepEqual(await saved({ renderParams: {}, assets: [] }), {});
  });

  it("looks up a preset authored by name alone", async () => {
    const style = await saved({ presetName: "ndvi", renderParams: {}, assets: [] });
    assert.equal(style.presetName, "ndvi");
    assert.equal(style.renderParams?.expression, "(B08-B04)/(B08+B04)");
    assert.equal(style.renderParams?.asset_as_band, true);
  });

  it("applies a partial override over the preset", async () => {
    const style = await saved({
      presetName: "ndvi",
      renderParams: { rescale: "0,0.8" },
      assets: [],
    });
    assert.equal(style.renderParams?.rescale, "0,0.8");
    assert.equal(style.renderParams?.expression, "(B08-B04)/(B08+B04)");
    assert.equal(style.renderParams?.colormap_name, "rdylgn");
  });

  it("keeps a complete saved render as saved, whatever preset name rides along", async () => {
    // Explicit render parameters win over a preset when the layer is added, so
    // a restore must not graft the preset's expression and colormap back on.
    const style = await saved({
      presetName: "ndvi",
      renderParams: { assets: ["B04"], rescale: "0,3000" },
      assets: ["B04"],
    });
    assert.deepEqual(style.renderParams, { assets: ["B04"], rescale: "0,3000" });
    assert.deepEqual(style.assets, ["B04"]);

    const expression = await saved({
      presetName: "true-color",
      renderParams: { expression: "B08/B04", asset_as_band: true },
      assets: [],
    });
    assert.deepEqual(expression.renderParams, { expression: "B08/B04", asset_as_band: true });
    assert.equal(expression.assets, undefined);
  });
});

describe("planetaryComputerSearchParams", () => {
  it("defaults to newest first and omits unset filters", () => {
    assert.deepEqual(planetaryComputerSearchParams({ collection: "naip" }), {
      collections: ["naip"],
      sortby: [{ field: "properties.datetime", direction: "desc" }],
    });
  });

  it("translates the cloud cover limit and the sort choices", () => {
    const params = planetaryComputerSearchParams({
      collection: "sentinel-2-l2a",
      bbox: [-1, -2, 3, 4],
      datetime: "2024-06-01/2024-08-31",
      maxCloudCover: 10,
      limit: 5,
      sortBy: "least-cloudy",
    });
    assert.deepEqual(params.query, { "eo:cloud_cover": { lte: 10 } });
    assert.deepEqual(params.sortby, [{ field: "properties.eo:cloud_cover", direction: "asc" }]);
    assert.deepEqual(params.bbox, [-1, -2, 3, 4]);
    assert.equal(params.limit, 5);
    assert.equal(
      planetaryComputerSearchParams({ collection: "x", sortBy: "oldest" }).sortby?.[0].direction,
      "asc",
    );
    // 100% is "no limit", so no filter is sent.
    assert.equal(
      planetaryComputerSearchParams({ collection: "x", maxCloudCover: 100 }).query,
      undefined,
    );
  });
});

describe("planetaryComputerItemDate", () => {
  it("falls back from datetime to the range bounds", () => {
    assert.equal(
      planetaryComputerItemDate(stacItem("a", { datetime: "2024-01-02T00:00:00Z" })),
      "2024-01-02T00:00:00Z",
    );
    assert.equal(
      planetaryComputerItemDate(stacItem("b", { start_datetime: "2021-01-01T00:00:00Z" })),
      "2021-01-01T00:00:00Z",
    );
    assert.equal(planetaryComputerItemDate(stacItem("c", {})), undefined);
  });
});

describe("Planetary Computer time-series stack", () => {
  const items = [
    stacItem("newest", { datetime: "2024-09-06T19:09:21Z" }),
    stacItem("same-day-second", { datetime: "2024-09-06T19:09:40Z" }),
    stacItem("middle", { datetime: "2024-08-07T19:09:11Z" }),
    stacItem("undated", {}),
    stacItem("oldest", { start_datetime: "2024-06-20T18:59:19Z" }),
  ];

  it("keeps one item per day, oldest first, preferring the search order", () => {
    assert.deepEqual(planetaryComputerStackItems(items), [
      { id: "oldest", date: "2024-06-20" },
      { id: "middle", date: "2024-08-07" },
      { id: "newest", date: "2024-09-06" },
    ]);
  });

  it("prefers the scene covering most of the search area on each day", () => {
    const tile = (id: string, datetime: string, bbox: number[]) => {
      const item = stacItem(id, { datetime });
      item.bbox = bbox;
      return item;
    };
    const focus: [number, number, number, number] = [-122.6, 47.4, -122.0, 47.8];
    const stackItems = planetaryComputerStackItems(
      [
        // Sorted first by the search, but this neighboring tile only clips the area.
        tile("north-tile", "2024-09-06T19:09:40Z", [-123, 47.75, -121.5, 48.75]),
        tile("covering-tile", "2024-09-06T19:09:21Z", [-123, 46.86, -121.53, 47.85]),
        // A day whose only scene misses the area entirely is left out.
        tile("far-away", "2024-09-08T19:00:00Z", [-110, 30, -109, 31]),
        tile("earlier", "2024-08-07T19:09:11Z", [-123, 46.86, -121.53, 47.85]),
      ],
      focus,
    );
    assert.deepEqual(stackItems, [
      { id: "earlier", date: "2024-08-07" },
      { id: "covering-tile", date: "2024-09-06" },
    ]);
  });

  const stack: PlanetaryComputerStack = {
    collection: "sentinel-2-l2a",
    items: planetaryComputerStackItems(items),
    renderParams: { assets: ["visual"] },
  };

  it("shows the item of the date, else the latest earlier one, else the first", () => {
    const at = (date: string) => planetaryComputerStackItemAt(stack, new Date(date)).id;
    assert.equal(at("2024-08-07T00:00:00Z"), "middle");
    assert.equal(at("2024-08-20T00:00:00Z"), "middle");
    assert.equal(at("2024-12-01T00:00:00Z"), "newest");
    assert.equal(at("2020-01-01T00:00:00Z"), "oldest");
  });

  it("builds an XYZ source that resolves each date to that item's tiles", async () => {
    const source = planetaryComputerStackSource("stack-1", "Stack", stack) as unknown as {
      id: string;
      type: string;
      tiles: (date: Date) => Promise<string>;
      [PLANETARY_COMPUTER_STACK_KEY]: PlanetaryComputerStack;
    };
    assert.equal(source.type, "xyz");
    assert.equal(source.id, "stack-1");
    const url = await source.tiles(new Date("2024-08-07T00:00:00Z"));
    assert.equal(
      url,
      "https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=sentinel-2-l2a&item=middle&assets=visual",
    );
    // A stable remote reference stands in for the function-valued tile URL, so
    // the mirrored layer is recognized as hosted (shareable, reloadable).
    assert.equal(
      (source as unknown as { referenceUrl: string }).referenceUrl,
      "https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a",
    );
    // The description is plain JSON, so it survives the project file although
    // the resolver function does not.
    const saved = JSON.parse(JSON.stringify(source));
    assert.equal(saved.tiles, undefined);
    assert.deepEqual(parsePlanetaryComputerStack(saved[PLANETARY_COMPUTER_STACK_KEY]), stack);
  });

  it("rejects a malformed saved stack", () => {
    assert.equal(parsePlanetaryComputerStack(null), null);
    assert.equal(parsePlanetaryComputerStack({ collection: "", items: [] }), null);
    assert.equal(
      parsePlanetaryComputerStack({ collection: "x", items: [{ id: "a", date: "June" }] }),
      null,
    );
    assert.deepEqual(
      parsePlanetaryComputerStack({
        collection: "x",
        items: [
          { id: "a", date: "2024-01-01" },
          { id: 5, date: "2024-01-02" },
        ],
      }),
      { collection: "x", items: [{ id: "a", date: "2024-01-01" }], renderParams: {} },
    );
  });
});

describe("planetaryComputerStackReader", () => {
  const stack: PlanetaryComputerStack = {
    collection: "sentinel-2-l2a",
    items: [
      { id: "first", date: "2024-06-20" },
      { id: "second", date: "2024-09-06" },
    ],
    renderParams: { expression: "(B08-B04)/(B08+B04)", asset_as_band: true },
  };

  async function withFetch<T>(body: unknown, run: (urls: string[]) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      return await run(urls);
    } finally {
      globalThis.fetch = original;
    }
  }

  it("reads the date's item through the Data API point endpoint", async () => {
    const reader = planetaryComputerStackReader(stack);
    await withFetch(
      { values: [0.4815, null], band_names: ["(B08-B04)/(B08+B04)"] },
      async (urls) => {
        const reading = await reader(new Date("2024-09-06T00:00:00Z"), [-122.15, 47.55]);
        assert.equal(urls.length, 1);
        const url = new URL(urls[0]);
        assert.equal(url.pathname, "/api/data/v1/item/point/-122.15,47.55");
        assert.equal(url.searchParams.get("item"), "second");
        assert.equal(url.searchParams.get("asset_as_band"), "true");
        assert.deepEqual(reading?.bands, [
          { index: 1, name: "(B08-B04)/(B08+B04)", value: 0.4815, isNodata: false },
          { index: 2, name: null, value: Number.NaN, isNodata: true },
        ]);
      },
    );
  });

  it("charts a gap for a date without its own acquisition", async () => {
    const reader = planetaryComputerStackReader(stack);
    await withFetch({ values: [1] }, async (urls) => {
      assert.equal(await reader(new Date("2024-08-01T00:00:00Z"), [-122.15, 47.55]), null);
      assert.equal(urls.length, 0);
    });
  });
});

describe("planetaryComputerColorbar", () => {
  it("maps a named colormap and its rescale range", () => {
    assert.deepEqual(
      planetaryComputerColorbar({
        renderParams: {
          expression: "(B08-B04)/(B08+B04)",
          rescale: "-1,1",
          colormap_name: "rdylgn",
        },
        presetName: "ndvi",
      }),
      { colormap: "RdYlGn", vmin: -1, vmax: 1, label: "NDVI" },
    );
  });

  it("falls back to explicit colors for a colormap the Colorbar control has no name for", () => {
    const colorbar = planetaryComputerColorbar({
      renderParams: { assets: ["lwir11"], rescale: "290,320", colormap_name: "blues" },
    });
    assert.ok(Array.isArray(colorbar?.colormap));
    assert.equal(colorbar?.label, "lwir11");
    assert.equal(colorbar?.vmin, 290);
  });

  it("has nothing to show without a colormap or a numeric range", () => {
    assert.equal(planetaryComputerColorbar({ renderParams: { assets: ["visual"] } }), null);
    assert.equal(planetaryComputerColorbar({ renderParams: { colormap_name: "viridis" } }), null);
    assert.equal(
      planetaryComputerColorbar({ renderParams: { colormap_name: "viridis", rescale: "5,5" } }),
      null,
    );
  });
});

describe("clampClipBounds", () => {
  it("keeps the part of the box inside the item footprint", () => {
    assert.deepEqual(
      clampClipBounds([-124, 46, -122, 47.5], [-123, 46.8, -121.5, 47.8]),
      [-123, 46.8, -122, 47.5],
    );
    // A 3D item bbox is [west, south, minz, east, north, maxz].
    assert.deepEqual(
      clampClipBounds([-124, 46, -122, 47.5], [-123, 46.8, 0, -121.5, 47.8, 9]),
      [-123, 46.8, -122, 47.5],
    );
    assert.deepEqual(clampClipBounds([1, 2, 3, 4], undefined), [1, 2, 3, 4]);
  });

  it("reports a box that misses the item", () => {
    assert.equal(clampClipBounds([10, 10, 11, 11], [-123, 46.8, -121.5, 47.8]), null);
  });
});

describe("wrapLongitude", () => {
  it("maps a repeated world copy back into the geographic range", () => {
    assert.equal(wrapLongitude(181), -179);
    assert.equal(wrapLongitude(-181), 179);
    assert.equal(wrapLongitude(-122.33), -122.33);
    assert.equal(wrapLongitude(540), -180);
  });
});

describe("planetaryComputerIdentifyProperties", () => {
  it("lists band values, the item, and the clicked coordinates", () => {
    const properties = planetaryComputerIdentifyProperties(
      {
        itemId: "S2_ITEM",
        values: [
          { name: "B04_b1", value: 1158 },
          { name: "B08_b1", value: null },
        ],
      },
      {
        item: "Item",
        nodata: "no data",
        coordinates: "lon, lat",
        lngLat: [-122.080521, 48.199941],
      },
    );
    assert.deepEqual(Object.entries(properties), [
      ["B04_b1", "1158"],
      ["B08_b1", "no data"],
      ["Item", "S2_ITEM"],
      ["lon, lat", "-122.08052, 48.19994"],
    ]);
  });
});
