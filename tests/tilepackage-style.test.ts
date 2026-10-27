import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StyleSpecification } from "maplibre-gl";
import {
  TILEPACKAGE_PROTOCOL,
  createLocalTilePackageKeyGenerator,
  isLocalTilePackageKey,
  isTilePackageFileName,
  localTilePackageKeyFromUrl,
  localTilePackageKeysInLayers,
  prepareVtpkStyle,
  tilePackageBaseName,
  tilePackageBounds,
  tilePackageTileUrl,
} from "../apps/geolibre-desktop/src/lib/tilepackage-style";

const TILE_URL = "tilepackage://https://example.com/leon.vtpk/{z}/{x}/{y}";

/** The shape `TilePackage.getStyle()` returns for a VTPK (Esri street map). */
function esriStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: "tilepackage://https://example.com/leon.vtpk/{fontstack}/{range}",
    sprite: "tilepackage://https://example.com/leon.vtpk/sprite",
    sources: {
      esri: { type: "vector", tiles: [TILE_URL], minzoom: 0, maxzoom: 16 },
    },
    layers: [
      { id: "Land", type: "background", paint: { "background-color": "#eee" } },
      {
        id: "Water",
        type: "fill",
        source: "esri",
        "source-layer": "Water",
        paint: { "fill-color": "#0af", "fill-pattern": "hatch" },
      },
      {
        id: "Road/Line",
        type: "line",
        source: "esri",
        "source-layer": "Road",
        paint: { "line-color": "#333", "line-pattern": "dash" },
      },
      {
        id: "Road/Label",
        type: "symbol",
        source: "esri",
        "source-layer": "Road",
        layout: {
          "text-field": "{_name}",
          "text-font": ["Arial Regular"],
          "icon-image": "shield",
          "icon-size": 1,
        },
        paint: { "text-color": "#000", "icon-opacity": 0.5 },
      },
      {
        id: "Poi/Icon",
        type: "symbol",
        source: "esri",
        "source-layer": "Poi",
        layout: { "icon-image": "pin" },
      },
      { id: "Hillshade", type: "hillshade", source: "dem" },
      { id: "NoSourceLayer", type: "fill", source: "esri" },
    ],
  } as StyleSpecification;
}

describe("tile package file names", () => {
  it("recognises .vtpk and .tpkx, ignoring case and a query string", () => {
    assert.equal(isTilePackageFileName("leon.vtpk"), true);
    assert.equal(isTilePackageFileName("SF.TPKX"), true);
    assert.equal(isTilePackageFileName("https://h/x/usa.tpkx?download=1"), true);
    assert.equal(isTilePackageFileName("map.zip"), false);
    assert.equal(isTilePackageFileName("vtpk"), false);
  });

  it("names a layer from the file stem of a path or URL", () => {
    assert.equal(tilePackageBaseName("leon.vtpk"), "leon");
    assert.equal(tilePackageBaseName("https://data.source.coop/gishub/vtpk/world.vtpk"), "world");
    assert.equal(tilePackageBaseName("C:\\maps\\New Zealand.vtpk"), "New Zealand");
    assert.equal(tilePackageBaseName("https://h/usa.tpkx?x=1#f"), "usa");
    assert.equal(tilePackageBaseName(""), "Tile package");
  });

  it("builds the tile template the protocol resolves", () => {
    assert.equal(
      tilePackageTileUrl("https://h/leon.vtpk"),
      `${TILEPACKAGE_PROTOCOL}://https://h/leon.vtpk/{z}/{x}/{y}`,
    );
  });
});

describe("createLocalTilePackageKeyGenerator", () => {
  it("never repeats a key, even for the same file name", () => {
    const next = createLocalTilePackageKeyGenerator("abc");
    const first = next("map.vtpk");
    const second = next("map.vtpk");
    assert.notEqual(first, second);
    assert.ok(first.includes("abc") && first.endsWith("map.vtpk"));
  });

  it("separates sessions, so a saved key cannot resolve to another session's file", () => {
    const a = createLocalTilePackageKeyGenerator("one")("map.vtpk");
    const b = createLocalTilePackageKeyGenerator("two")("map.vtpk");
    assert.notEqual(a, b);
  });

  it("keeps the key to characters that survive a tile URL", () => {
    const key = createLocalTilePackageKeyGenerator("s")("New Zealand (2024)/map #1.vtpk");
    assert.match(key, /^[A-Za-z0-9._-]+$/);
  });

  it("makes keys that are recognised as local, unlike a URL", () => {
    const key = createLocalTilePackageKeyGenerator("s")("map.vtpk");
    assert.equal(isLocalTilePackageKey(key), true);
    assert.equal(isLocalTilePackageKey("https://example.com/local-map.vtpk"), false);
  });
});

describe("localTilePackageKeyFromUrl", () => {
  it("reads the key out of a tile, style or glyph request for a local file", () => {
    const key = createLocalTilePackageKeyGenerator("s")("map.vtpk");
    assert.equal(localTilePackageKeyFromUrl(tilePackageTileUrl(key)), key);
    assert.equal(localTilePackageKeyFromUrl(`tilepackage://${key}/3/4/5`), key);
    assert.equal(localTilePackageKeyFromUrl(`tilepackage://${key}`), key);
  });

  it("ignores requests for a package at a URL and for other protocols", () => {
    assert.equal(localTilePackageKeyFromUrl(TILE_URL), null);
    assert.equal(localTilePackageKeyFromUrl("https://example.com/local-x/1/2/3"), null);
  });
});

describe("localTilePackageKeysInLayers", () => {
  const next = createLocalTilePackageKeyGenerator("s");
  const first = next("a.vtpk");
  const second = next("b.tpkx");

  it("collects local keys across live layers and history snapshots", () => {
    const keys = localTilePackageKeysInLayers([
      [{ metadata: { packageKey: first } }],
      [{ metadata: { packageKey: second } }, { metadata: {} }, {}],
    ]);
    assert.deepEqual([...keys].sort(), [first, second].sort());
  });

  it("skips packages at a URL, which the protocol reopens on demand", () => {
    const keys = localTilePackageKeysInLayers([
      [{ metadata: { packageKey: "https://example.com/leon.vtpk" } }],
    ]);
    assert.equal(keys.size, 0);
  });
});

describe("tilePackageBounds", () => {
  it("uses degrees as they are, even when the package declares Web Mercator", () => {
    // Leon County's real header: spatialReference 3857, extent in degrees.
    const bounds = tilePackageBounds({
      minLon: -84.7243950172582,
      minLat: 30.179292597278,
      maxLon: -83.9318519655224,
      maxLat: 30.7782502881054,
      spatialReference: 3857,
    });
    assert.deepEqual(
      bounds,
      [-84.7243950172582, 30.179292597278, -83.9318519655224, 30.7782502881054],
    );
  });

  it("converts a Web Mercator extent in metres to degrees", () => {
    const bounds = tilePackageBounds({
      minLon: -20037508.342789244,
      minLat: -20037508.342789244,
      maxLon: 20037508.342789244,
      maxLat: 20037508.342789244,
      spatialReference: 102100,
    });
    assert.ok(bounds);
    const [west, south, east, north] = bounds;
    assert.ok(Math.abs(west + 180) < 1e-9 && Math.abs(east - 180) < 1e-9);
    assert.ok(Math.abs(south + 85.0511287798) < 1e-6 && Math.abs(north - 85.0511287798) < 1e-6);
  });

  it("converts metres when the package declares no spatial reference", () => {
    const bounds = tilePackageBounds({
      minLon: 11700000,
      minLat: 2380000,
      maxLon: 11760000,
      maxLat: 2440000,
    });
    assert.ok(bounds);
    assert.ok(bounds[0] > 105 && bounds[0] < 106 && bounds[1] > 20 && bounds[1] < 22);
  });

  it("returns null for a projection it cannot place rather than a wrong box", () => {
    // UTM zone 17N metres would pass the Web Mercator range check.
    assert.equal(
      tilePackageBounds({
        minLon: 500000,
        minLat: 3300000,
        maxLon: 600000,
        maxLat: 3400000,
        spatialReference: 32617,
      }),
      null,
    );
  });

  it("returns null for a missing, non-numeric or inverted extent", () => {
    assert.equal(tilePackageBounds({}), null);
    assert.equal(tilePackageBounds({ minLon: Number.NaN, minLat: 0, maxLon: 1, maxLat: 1 }), null);
    assert.equal(tilePackageBounds({ minLon: 10, minLat: 0, maxLon: -10, maxLat: 1 }), null);
  });
});

describe("prepareVtpkStyle", () => {
  const prepared = prepareVtpkStyle(esriStyle(), "layer-1", { tileUrl: TILE_URL });

  it("scopes source and layer ids to the GeoLibre layer", () => {
    assert.deepEqual(prepared.sourceIds, ["layer-1-esri"]);
    assert.deepEqual(prepared.nativeLayerIds, [
      "layer-1-Water",
      "layer-1-Road/Line",
      "layer-1-Road/Label",
    ]);
    for (const layer of prepared.layers) {
      assert.equal((layer as { source?: string }).source, "layer-1-esri");
    }
  });

  it("keeps the package tile template on the vector source", () => {
    const source = prepared.sources["layer-1-esri"] as { type: string; tiles: string[] };
    assert.equal(source.type, "vector");
    assert.deepEqual(source.tiles, [TILE_URL]);
  });

  it("drops the background, non-vector layers and layers with no source layer", () => {
    assert.deepEqual(prepared.droppedLayerIds, ["Land", "Poi/Icon", "Hillshade", "NoSourceLayer"]);
  });

  it("replaces a sprite-backed pattern with the layer's own colour", () => {
    const water = prepared.layers.find((layer) => layer.id === "layer-1-Water");
    assert.deepEqual(water?.paint, { "fill-color": "#0af" });
    const road = prepared.layers.find((layer) => layer.id === "layer-1-Road/Line");
    assert.deepEqual(road?.paint, { "line-color": "#333" });
  });

  it("drops a pattern-only layer rather than drawing MapLibre's default paint", () => {
    const style = {
      version: 8,
      sources: { esri: { type: "vector", tiles: ["x/{z}/{x}/{y}"] } },
      layers: [
        {
          id: "Fill",
          type: "fill",
          source: "esri",
          "source-layer": "A",
          paint: { "fill-pattern": "p" },
        },
        {
          id: "Line",
          type: "line",
          source: "esri",
          "source-layer": "B",
          paint: { "line-pattern": "p" },
        },
        {
          id: "Extrusion",
          type: "fill-extrusion",
          source: "esri",
          "source-layer": "C",
          paint: { "fill-extrusion-pattern": "p" },
        },
        {
          id: "Plain",
          type: "fill",
          source: "esri",
          "source-layer": "D",
          paint: { "fill-color": "#fff" },
        },
      ],
    } as StyleSpecification;
    const result = prepareVtpkStyle(style, "layer-2", { tileUrl: TILE_URL });
    assert.deepEqual(result.droppedLayerIds, ["Fill", "Line", "Extrusion"]);
    assert.deepEqual(result.nativeLayerIds, ["layer-2-Plain"]);
  });

  it("keeps labels, moves them to a basemap font and drops their icon", () => {
    const label = prepared.layers.find((layer) => layer.id === "layer-1-Road/Label");
    assert.deepEqual(label?.layout, {
      "text-field": "{_name}",
      "text-font": ["Noto Sans Regular"],
    });
    assert.deepEqual(label?.paint, { "text-color": "#000" });
  });

  it("uses the font the caller resolved from the basemap", () => {
    const custom = prepareVtpkStyle(esriStyle(), "layer-1", {
      tileUrl: TILE_URL,
      textFont: ["Open Sans Regular"],
    });
    const label = custom.layers.find((layer) => layer.id === "layer-1-Road/Label");
    const layout = label?.layout as Record<string, unknown> | undefined;
    assert.deepEqual(layout?.["text-font"], ["Open Sans Regular"]);
  });

  it("does not mutate the style it was given", () => {
    const style = esriStyle();
    const before = structuredClone(style);
    prepareVtpkStyle(style, "layer-1", { tileUrl: TILE_URL });
    assert.deepEqual(style, before);
  });

  it("gives a source without tiles the package template, and skips hosted sources", () => {
    const style = {
      version: 8,
      sources: {
        esri: { type: "vector", url: "tilepackage://https://example.com/leon.vtpk" },
        remote: { type: "vector", url: "https://tiles.example.com/other.json" },
        photo: { type: "raster", tiles: ["https://img.example.com/{z}/{x}/{y}.png"] },
      },
      layers: [
        { id: "A", type: "line", source: "esri", "source-layer": "A" },
        { id: "B", type: "line", source: "remote", "source-layer": "B" },
        { id: "C", type: "raster", source: "photo" },
      ],
    } as unknown as StyleSpecification;
    const result = prepareVtpkStyle(style, "x", { tileUrl: TILE_URL });
    assert.deepEqual(result.sourceIds, ["x-esri"]);
    assert.deepEqual((result.sources["x-esri"] as { tiles: string[]; url?: string }).tiles, [
      TILE_URL,
    ]);
    assert.equal("url" in result.sources["x-esri"], false);
    assert.deepEqual(result.nativeLayerIds, ["x-A"]);
    assert.deepEqual(result.droppedLayerIds, ["B", "C"]);
  });

  it("returns no layers for a style with nothing drawable", () => {
    const empty = prepareVtpkStyle(
      { version: 8, sources: {}, layers: [] } as StyleSpecification,
      "x",
      { tileUrl: TILE_URL },
    );
    assert.deepEqual(empty.layers, []);
    assert.deepEqual(empty.nativeLayerIds, []);
  });
});
